/**
 * The application half of the fail-open tests (D83), run as its own process by
 * `init.test.ts` — `init()` is idempotent and registers process-global OTel
 * state, so each scenario needs a process of its own.
 *
 * The contract under test is app-observable and nothing else: whatever is wrong
 * with the telemetry setup, this script prints its answers and exits 0. It is
 * deliberately shaped like the smallest possible customer app.
 *
 * Usage: `tsx init-failopen.fixture.ts <scenario>`, with the environment set by
 * the caller. Scenarios:
 *
 *   healthy            — a reachable endpoint; the control case
 *   unreachable        — OTEL_EXPORTER_OTLP_ENDPOINT on a dead port
 *   malformed-env      — OTEL_* set to values that parse as nothing
 *   broken-dependency  — one of init()'s own dependencies made to throw
 */
const scenario = process.argv[2];

if (scenario === "broken-dependency") {
  // The realistic way init() actually explodes in the field is a dependency it
  // cannot use — an incompatible OTel version, a half-installed package. Stock
  // OTel is lenient enough that no OTEL_* value on its own reaches init()'s
  // catch (measured), so proving the catch needs a dependency that throws where
  // one really could. This poisons the require cache before init is loaded, so
  // `new NodeSDK(...)` inside init() raises.
  const sdkNode = require.resolve("@opentelemetry/sdk-node");
  require(sdkNode);
  const cached = require.cache[sdkNode];
  if (!cached) throw new Error("fixture: @opentelemetry/sdk-node was not cached; the poison would be a no-op");
  cached.exports = new Proxy(cached.exports as object, {
    get(target, property, receiver) {
      if (property === "NodeSDK") throw new Error("simulated broken OTel dependency");
      return Reflect.get(target, property, receiver);
    },
  });
}

async function main(): Promise<void> {
  const { init, traceAgent, traceTool } = require("./index") as typeof import("./index");

  const sdk = init();
  const agent = await traceAgent("fixture_step", async () => {
    const tool = traceTool("fixture_tool", () => "tool value");
    return `agent saw ${tool}`;
  });

  process.stdout.write(
    JSON.stringify({
      scenario,
      handle: typeof sdk.shutdown === "function",
      agent,
      semconv: process.env.OTEL_SEMCONV_STABILITY_OPT_IN,
    }) + "\n",
  );

  // Shutting down flushes; against a dead endpoint the flush fails, and that
  // failure must not become the process's exit code either.
  await sdk.shutdown();
}

void main();
