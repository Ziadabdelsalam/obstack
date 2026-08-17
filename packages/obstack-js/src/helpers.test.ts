import assert from "node:assert/strict";
import test, { after } from "node:test";
import { SpanKind, SpanStatusCode, trace, type Tracer, type TracerProvider } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { traceAgent, traceTool } from "./helpers";
import { D8 } from "./testing/d8-contract";
import { captureSpans } from "./testing/harness";

const spans = captureSpans();

after(async () => {
  await spans.shutdown();
});

const named = (name: string): ReadableSpan => {
  const found = spans.finishedSpans().filter((span) => span.name === name);
  assert.equal(
    found.length,
    1,
    `expected exactly one span named "${name}", saw ${found.length} (${spans.finishedSpans().map((s) => s.name).join(", ") || "none"})`,
  );
  return found[0]!;
};

test("traceAgent names the span agent.<step> and marks the agent layer", async () => {
  const answer = await traceAgent("plan", async () => "planned");
  assert.equal(answer, "planned");

  const span = named("agent.plan");
  // `obstack.agent.step` is the whole reason this span reads as the agent layer
  // in ingest — without it the span is classified `other` and the four-layer
  // trace loses a layer.
  assert.equal(span.attributes[D8.agentStep], "plan");
  assert.equal(span.kind, SpanKind.INTERNAL);
  assert.equal(span.status.code, SpanStatusCode.UNSET);
});

test("traceTool names the span tool.<name> and marks the tool layer", () => {
  const answer = traceTool("search_runbook", () => ["restart ingest"]);
  assert.deepEqual(answer, ["restart ingest"]);

  const span = named("tool.search_runbook");
  assert.equal(span.attributes[D8.toolName], "search_runbook");
  assert.equal(span.kind, SpanKind.INTERNAL);
});

test("a tool called inside an agent step nests under it", async () => {
  await traceAgent("nesting", async () => traceTool("nested_tool", () => 1));

  const parent = named("agent.nesting");
  const child = named("tool.nested_tool");
  assert.equal(
    child.parentSpanContext?.spanId,
    parent.spanContext().spanId,
    "the tool span is not a child of the agent span; the trace would render as two roots instead of a four-layer tree",
  );
});

test("neither helper captures arguments or return values", () => {
  // Not an omission — a deliberate scope call. Application data is arbitrary
  // and shipping it to a backend is a PII decision nobody has taken this
  // sprint. If that changes, this test is where the change gets noticed.
  traceTool("no_capture", () => ({ secret: "hunter2" }));
  const span = named("tool.no_capture");
  assert.deepEqual(Object.keys(span.attributes), [D8.toolName]);
});

test("a synchronous application exception propagates untouched and is recorded", () => {
  const boom = new Error("tool blew up");
  assert.throws(
    () =>
      traceTool("sync_failure", () => {
        throw boom;
      }),
    (thrown: unknown) => thrown === boom,
  );

  const span = named("tool.sync_failure");
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.status.message, "tool blew up");
  assert.equal(span.events[0]?.name, "exception");
});

test("a rejected promise propagates untouched and is recorded", async () => {
  const boom = new Error("step blew up");
  await assert.rejects(
    async () => traceAgent("async_failure", async () => Promise.reject(boom)),
    (thrown: unknown) => thrown === boom,
  );

  const span = named("agent.async_failure");
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.events[0]?.name, "exception");
});

test("the span ends only once the returned promise settles", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));

  const pending = traceAgent("slow", async () => {
    await gate;
    return "done";
  });
  assert.equal(
    spans.finishedSpans().some((span) => span.name === "agent.slow"),
    false,
    "the span ended before the work did — its duration would be a lie",
  );

  release!();
  assert.equal(await pending, "done");
  named("agent.slow");
});

/**
 * The fail-open half (D83). Both cases below replace the tracer with one that
 * throws, which is the only way to ask the question the PRD actually cares
 * about: when the telemetry path breaks, does the application still work?
 */

function withBrokenTracer(tracer: Partial<Tracer>): () => void {
  const provider: TracerProvider = { getTracer: () => tracer as Tracer };
  trace.disable();
  trace.setGlobalTracerProvider(provider);
  return () => {
    trace.disable();
  };
}

test("a tracer that cannot start a span runs the function anyway", () => {
  const restore = withBrokenTracer({
    startActiveSpan: () => {
      throw new Error("no tracer today");
    },
  });
  try {
    assert.equal(
      traceTool("broken_tracer", () => "the app's answer"),
      "the app's answer",
    );
  } finally {
    restore();
  }
});

test("a span that cannot be ended still gives the application its value back", async () => {
  const restore = withBrokenTracer({
    startActiveSpan: ((_name: string, _options: unknown, fn: (span: unknown) => unknown) =>
      fn({
        end() {
          throw new Error("exporter exploded");
        },
        recordException() {},
        setStatus() {},
      })) as unknown as Tracer["startActiveSpan"],
  });
  try {
    assert.equal(await traceAgent("broken_end", async () => "still fine"), "still fine");
  } finally {
    restore();
  }
});
