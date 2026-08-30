import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { init } from "./init";
import { SDK_VERSION } from "./scope";

const run = promisify(execFile);
const FIXTURE = path.join(__dirname, "init-failopen.fixture.ts");
const DEAD_ENDPOINT = "http://127.0.0.1:1";

/**
 * `init()` is idempotent and registers process-global OTel state, so the
 * scenarios below cannot share a process. Each one runs
 * `init-failopen.fixture.ts` — a minimal application — as a child and is judged
 * on what an application can actually observe: its exit code and its output.
 * Nothing here inspects the SDK's internals, because "the telemetry backend is
 * down and the app still answers" is the whole claim (PRD §9, D83).
 */
type Scenario = "healthy" | "unreachable" | "malformed-env" | "broken-dependency";

async function runFixture(
  scenario: Scenario,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  const childEnv = { ...process.env };
  // Cleared unless a scenario sets it, so "init() left the environment alone"
  // is a statement about init() and not about whatever the CI runner exported.
  delete childEnv.OTEL_SEMCONV_STABILITY_OPT_IN;
  return run(process.execPath, ["--import", "tsx", FIXTURE, scenario], {
    env: { ...childEnv, ...env },
  });
}

/** The control case needs somewhere real to export to, or "it survived" says
 *  nothing about the difference between working and broken. */
let collector: Server;
let collectorEndpoint: string;
let received = 0;

before(async () => {
  collector = createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      received += 1;
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  collectorEndpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    collector.close((error) => (error ? reject(error) : resolve())),
  );
});

test("the version stamped on telemetry is the version in package.json", () => {
  // Everything obstack-js emits is labelled with SDK_VERSION; a stale copy
  // would attribute a bug report to the wrong release.
  const manifest = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(SDK_VERSION, manifest.version);
});

test("init() is idempotent and hands back the same handle", () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = DEAD_ENDPOINT;
  const first = init();
  const second = init();
  assert.equal(first, second, "a second init() built a second SDK; the app would export everything twice");
});

test("init() opens the ai 7 door — the integration is on the global registry", () => {
  // PROVEN RED FIRST, and the reason it exists: with `registerVercelAiV7Integration()`
  // deleted from `init.ts` the package suite stayed completely green. The v7
  // leg's own tests call that function themselves — they prove the integration
  // works, not that `init()` installs it — so the one line that gives a real
  // application its ai@7 spans was asserted by nothing. Deleting it ships an SDK
  // that is silently span-less on ai 7, which is the launch claim this sprint
  // exists for. With this test, deleting it goes red here.
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = DEAD_ENDPOINT;
  init();

  const registry = (globalThis as unknown as Record<string, unknown>)[
    "AI_SDK_TELEMETRY_INTEGRATIONS"
  ];
  assert.ok(
    Array.isArray(registry),
    "init() left ai 7's integration registry unset; an ai@7 app gets no llm spans and no error",
  );
  const ours = registry.filter(
    (entry) =>
      (entry as { constructor?: { name?: string } })?.constructor?.name === "ObstackVercelAiIntegration",
  );
  assert.equal(ours.length, 1, `init() registered obstack's v7 integration ${ours.length} times`);
  assert.equal(
    typeof (ours[0] as { executeLanguageModelCall?: unknown }).executeLanguageModelCall,
    "function",
    "the registered object is not the hook shape ai 7 dispatches to",
  );
});

test("shutdown() resolves even though the endpoint is dead", async () => {
  // NodeSDK.shutdown() rejects with the raw socket error when the final flush
  // cannot connect. An app awaiting it on the way out would die of an unhandled
  // rejection because its backend was down.
  await init().shutdown();
});

test("an app whose collector is listening comes up and exports", async () => {
  received = 0;
  const { stdout } = await runFixture("healthy", {
    OTEL_EXPORTER_OTLP_ENDPOINT: collectorEndpoint,
    OTEL_SEMCONV_STABILITY_OPT_IN: "http/dup",
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.agent, "agent saw tool value");
  // Whatever the app chose for OTEL_SEMCONV_STABILITY_OPT_IN is still there
  // afterwards — see the companion assertion in the dead-endpoint test for the
  // other half (unset stays unset). D91: this SDK writes no environment.
  assert.equal(result.semconv, "http/dup");
  assert.ok(received > 0, "nothing reached the collector, so the failure cases below prove nothing by comparison");
});

test("a dead endpoint does not break the application", async () => {
  const { stdout } = await runFixture("unreachable", {
    OTEL_EXPORTER_OTLP_ENDPOINT: DEAD_ENDPOINT,
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.agent, "agent saw tool value");
  assert.equal(result.handle, true);
  // Unset before init(), unset after (D91). instrumentation-http at the pinned
  // range never reads this variable and emits the stable http.request.method
  // regardless, so a default here would be dead code that reads like a
  // load-bearing one — and the api layer of the trace is fine without it.
  assert.equal(result.semconv, undefined);
});

test("malformed OTEL_* environment does not break the application", async () => {
  const { stdout } = await runFixture("malformed-env", {
    OTEL_EXPORTER_OTLP_ENDPOINT: ":::not-a-url",
    OTEL_EXPORTER_OTLP_HEADERS: "=====",
    OTEL_TRACES_SAMPLER: "nonsense",
    OTEL_BSP_SCHEDULE_DELAY: "abc",
  });
  assert.equal(JSON.parse(stdout.trim()).agent, "agent saw tool value");
});

test("a dependency that throws inside init() leaves the application running", async () => {
  // The one scenario that actually reaches init()'s catch. Stock OTel turned
  // out to accept every malformed OTEL_* value tried above without raising, so
  // the guard is exercised the way it really fails in the field instead — a
  // dependency that cannot be used. Without the try/catch this scenario exits
  // non-zero with the raw error, which is what makes it a test rather than a
  // restatement of hope.
  const { stdout, stderr } = await runFixture("broken-dependency", {
    OTEL_EXPORTER_OTLP_ENDPOINT: DEAD_ENDPOINT,
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.agent, "agent saw tool value", "the app lost its answer when telemetry failed");
  assert.equal(result.handle, true, "init() returned something that is not a usable handle");
  assert.match(
    stderr,
    /obstack: init\(\) failed/,
    "telemetry was disabled without a word; silence here looks exactly like working telemetry that never arrives",
  );
});
