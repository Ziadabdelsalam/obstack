import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

/**
 * Two things every unit suite in this package needs: somewhere for spans to
 * land, and a provider endpoint that answers deterministically.
 *
 * `node:test` runs each test FILE in its own process, so registering a global
 * tracer provider here is safe — the global state does not leak between files.
 */

/**
 * A real tracer provider exporting to memory, registered globally, with the
 * context manager a span needs to find its parent across an `await`. In an
 * application NodeSDK installs that context manager; a bare TracerProvider does
 * not, and without it every span comes out a root — which would quietly turn
 * the nesting assertions into assertions about nothing.
 */
export function captureSpans(...extraProcessors: SpanProcessor[]): {
  finishedSpans(): ReadableSpan[];
  shutdown(): Promise<void>;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [...extraProcessors, new SimpleSpanProcessor({ exporter })],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  return {
    finishedSpans: () => exporter.getFinishedSpans(),
    shutdown: () => provider.shutdown(),
  };
}

/**
 * A deterministic stand-in for a model provider, served over real HTTP so the
 * REAL client library runs: it builds the request, serialises it, parses the
 * response and hands back its own response object. A hand-rolled stub in place
 * of the client would prove nothing about instrumenting the client (S2.0 L1).
 * No API key is involved anywhere — `baseURL` simply points here.
 */
export async function fakeProvider(body: unknown): Promise<{
  baseURL: string;
  requests: unknown[];
  close(): Promise<void>;
}> {
  const requests: unknown[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        requests.push(undefined);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
