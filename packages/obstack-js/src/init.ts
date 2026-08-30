import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import { swallowed } from "./fail-open";
import { AnthropicInstrumentation } from "./instrumentation/anthropic";
import { OpenAIInstrumentation } from "./instrumentation/openai";
import { VercelAiTranslationProcessor } from "./vercel-ai";
import { registerVercelAiV7Integration } from "./vercel-ai-v7";

/** What `init()` hands back. Holding it is optional; shutting down is not
 *  automatic, because a library that installs process signal handlers behind
 *  an app's back is a surprise nobody asked for. */
export interface ObstackSDK {
  /** Flushes and stops the exporters. Await it before a deliberate exit.
   *  Never rejects — see the note on the implementation. */
  shutdown(): Promise<void>;
}

let sdk: ObstackSDK | undefined;

/**
 * The second of the two lines. Configures tracing and logging from the standard
 * `OTEL_*` environment — there is no obstack-specific environment variable, on
 * purpose: whatever a reader already knows about configuring OTel is the whole
 * configuration surface, and pointing this at any OTLP endpoint is a matter of
 * setting `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * Call it first, before importing anything it instruments — `openai`,
 * `@anthropic-ai/sdk` and `node:http` are patched as they are required, so a
 * module loaded earlier keeps its unpatched copy.
 *
 * Idempotent: a second call returns the first handle without touching anything.
 * Never throws (D83); if setup fails the app runs uninstrumented and says so
 * once on stderr.
 */
export function init(): ObstackSDK {
  if (sdk) return sdk;

  try {
    // No OTEL_SEMCONV_STABILITY_OPT_IN default here, deliberately (D91).
    // @opentelemetry/instrumentation-http at the pinned range contains zero
    // references to that variable and emits the stable `http.request.method`
    // unconditionally (utils.js:258 client, :514 server), so a default would be
    // dead code pretending to hold up the api layer. Python's obstack-py DOES
    // need its setdefault — that is a real difference between the two SDKs, not
    // an inconsistency to iron out.
    const node = new NodeSDK({
      // `spanProcessors` rather than `traceExporter` because the Vercel-AI
      // translation has to be a processor, and the two options are mutually
      // exclusive in NodeSDK. The cost is that OTEL_BSP_* batch tuning is not
      // read (sdk-node keeps that helper internal); everything that decides
      // where telemetry goes — endpoint, headers, timeout, compression — is
      // read by the exporter itself, from the environment, as usual.
      spanProcessors: [
        new VercelAiTranslationProcessor(),
        new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }),
      ],
      // Logs get a provider and an exporter and nothing else this sprint
      // (D84): code using the OTel logs API is exported, but obstack-js ships
      // no bridge from console/pino/winston. The README says so plainly.
      logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
      instrumentations: [
        // The api layer of the four-layer trace, for free, in every app: a
        // plain node:http server span carries http.request.method, which is
        // what ingest classifies on (D77(c)).
        new HttpInstrumentation(),
        new OpenAIInstrumentation(),
        new AnthropicInstrumentation(),
      ],
    });

    node.start();

    // The `ai` 7 leg, and the only door it uses: one integration object pushed
    // onto `globalThis.AI_SDK_TELEMETRY_INTEGRATIONS`. Not an instrumentation
    // and not a span processor, because `ai` 7 neither exposes a CJS module to
    // patch nor emits a span to translate — see vercel-ai-v7.ts. Nothing here
    // imports `ai`, so this line is inert in an app that does not have it, and
    // there is no ordering constraint: the array is read per operation, so a
    // push before `ai` is even loaded still arrives.
    registerVercelAiV7Integration();

    // Measured, not assumed: NodeSDK.shutdown() REJECTS when the final flush
    // cannot reach the endpoint (`connect ECONNREFUSED` straight out of the
    // socket, both the trace and the log pipeline). An app that awaits shutdown
    // on its way out would then die of an unhandled rejection because its
    // telemetry backend was down — precisely the failure D83 exists to prevent.
    // So the handle swallows it and says so through diag.
    sdk = {
      shutdown: async () => {
        try {
          await node.shutdown();
        } catch (error) {
          swallowed("flushing telemetry on shutdown", error);
        }
      },
    };
  } catch (error) {
    // One warning, on the console, because a diag logger cannot have been
    // registered through this SDK yet and silence here would look like working
    // telemetry that simply never arrives.
    console.warn("obstack: init() failed; the app continues with telemetry disabled", error);
    sdk = { shutdown: async () => {} };
  }

  return sdk;
}
