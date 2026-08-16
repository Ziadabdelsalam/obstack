import assert from "node:assert/strict";
import test from "node:test";
import { NEARBY_LOG_CAP } from "@/lib/nearby-logs";
import {
  toLogRecord,
  toSpan,
  toTrace,
  toTraceSummary,
  type LogRow,
  type SpanRow,
  type TraceSummaryRow,
} from "./adapters";

// run with: node --conditions=react-server --test src/server/adapters.test.ts

const summaryRow: TraceSummaryRow = {
  trace_id: "3a55f0efeeb800e757fd61001b7cff2e",
  min_start_ns: "1786760035674781468",
  started_ms: "1786760035674",
  duration_ns: "44352000",
  span_count: "5",
  error_count: "0",
  input_tokens: "76",
  output_tokens: "33",
  cost_usd: 0.00003615,
  // alphabetically ahead of the root's service, so the list-view assertions
  // below fail if `service` ever falls back to `services[0]` again
  services: ["a-vector-db", "demo-agent"],
  models: ["gpt-4o-mini"],
  root_name: "POST /chat",
  root_method: "POST",
  root_service: "demo-agent",
};

const spanRow: SpanRow = {
  span_id: "b1",
  parent_span_id: "",
  name: "POST /chat",
  layer: "api",
  service: "demo-agent",
  start_offset_ns: "0",
  duration_ns: "44352000",
  status_code: "unset",
  status_message: "",
  k8s_pod: "",
  k8s_node: "",
  gen_ai_request_model: "",
  gen_ai_response_model: "",
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  finish_reason: "",
  prompt: "",
  completion: "",
  attributes: { "http.route": "/chat" },
};

const llmRow: SpanRow = {
  ...spanRow,
  span_id: "b4",
  parent_span_id: "b2",
  name: "chat gpt-4o-mini",
  layer: "llm",
  start_offset_ns: "12500000",
  duration_ns: "8000000",
  gen_ai_request_model: "gpt-4o-mini",
  gen_ai_response_model: "gpt-4o-mini-2024-07-18",
  input_tokens: 76,
  output_tokens: 33,
  cost_usd: 0.00003615,
  finish_reason: "stop",
  prompt: "user: hello",
  completion: "hi there",
  attributes: { "gen_ai.system": "openai" },
};

const logRow: LogRow = {
  at_offset_ns: "-2000000",
  trace_id: "3a55f0efeeb800e757fd61001b7cff2e",
  severity_number: 9,
  severity_text: "INFO",
  body: "chat turn started",
  k8s_namespace: "",
  k8s_pod: "",
  k8s_container: "",
};

test("span row maps offsets, durations and identity", () => {
  const span = toSpan(spanRow, summaryRow.trace_id);
  assert.equal(span.id, "b1");
  assert.equal(span.traceId, summaryRow.trace_id);
  assert.equal(span.parentId, null);
  assert.equal(span.startMs, 0);
  assert.equal(span.durationMs, 44.352);
  assert.equal(span.status, "ok");
  assert.equal(span.statusMessage, undefined);
  assert.equal(span.pod, undefined);
  assert.equal(span.node, undefined);
  assert.equal(span.llm, undefined);
  assert.deepEqual(span.attrs, { "http.route": "/chat" });
});

test("child span keeps its parent and error status", () => {
  const span = toSpan(
    { ...spanRow, parent_span_id: "b1", status_code: "error", status_message: "boom" },
    summaryRow.trace_id,
  );
  assert.equal(span.parentId, "b1");
  assert.equal(span.status, "error");
  assert.equal(span.statusMessage, "boom");
});

test("llm span carries the GenAI columns, response model wins", () => {
  const span = toSpan(llmRow, summaryRow.trace_id);
  assert.equal(span.startMs, 12.5);
  assert.deepEqual(span.llm, {
    model: "gpt-4o-mini-2024-07-18",
    inputTokens: 76,
    outputTokens: 33,
    costUsd: 0.00003615,
    prompt: "user: hello",
    completion: "hi there",
    finishReason: "stop",
  });
});

test("finish reason folds onto the UI union", () => {
  const reason = (finish_reason: string, status_code = "unset") =>
    toSpan({ ...llmRow, finish_reason, status_code }, "t")!.llm!.finishReason;
  assert.equal(reason("max_tokens"), "length");
  assert.equal(reason("content_filter"), "truncated");
  assert.equal(reason("end_turn"), "stop");
  assert.equal(reason("something_new"), "stop");
  assert.equal(reason("stop", "error"), "error");
});

test("unclassified layer falls back to other", () => {
  assert.equal(toSpan({ ...spanRow, layer: "other" }, "t").layer, "other");
  assert.equal(toSpan({ ...spanRow, layer: "wat" }, "t").layer, "other");
});

test("log row maps a negative offset and severity", () => {
  const log = toLogRecord(logRow, 2);
  assert.equal(log.id, `${summaryRow.trace_id}-2`);
  assert.equal(log.traceId, summaryRow.trace_id);
  assert.equal(log.atMs, -2);
  assert.equal(log.severity, "info");
  assert.equal(log.container, "app");
  assert.equal(log.pod, "");
});

test("severity numbers map onto the UI union", () => {
  const sev = (severity_number: number) => toLogRecord({ ...logRow, severity_number }, 0).severity;
  assert.equal(sev(1), "debug");
  assert.equal(sev(5), "debug");
  assert.equal(sev(13), "warn");
  assert.equal(sev(17), "error");
  assert.equal(sev(21), "fatal");
  assert.equal(toLogRecord({ ...logRow, severity_number: 0, severity_text: "WARNING" }, 0).severity, "warn");
});

test("log with no span context is a nearby log", () => {
  assert.equal(toLogRecord({ ...logRow, trace_id: "" }, 0).traceId, undefined);
});

test("summary row maps a list-view trace with no spans or logs", () => {
  const trace = toTraceSummary(summaryRow);
  assert.equal(trace.id, summaryRow.trace_id);
  assert.equal(trace.rootName, "POST /chat");
  assert.equal(trace.method, "POST");
  assert.equal(trace.startedAt, new Date(1786760035674).toISOString());
  assert.equal(trace.durationMs, 44.352);
  assert.equal(trace.status, "ok");
  assert.equal(trace.spanCount, 5);
  assert.equal(trace.totalTokens, 109);
  assert.equal(trace.costUsd, 0.00003615);
  assert.equal(trace.service, "demo-agent");
  assert.deepEqual(trace.spans, []);
  assert.deepEqual(trace.logs, []);
});

test("error count promotes the trace to error, empty root falls back", () => {
  const trace = toTraceSummary({ ...summaryRow, error_count: "2", root_name: "", root_method: "" });
  assert.equal(trace.status, "error");
  assert.equal(trace.rootName, "(unnamed root)");
  assert.equal(trace.method, "—");
});

test("trace detail stitches spans and logs, leaving explanation and k8sEvents undefined", () => {
  const trace = toTrace(summaryRow, [spanRow, llmRow], [logRow], []);
  assert.equal(trace.spans.length, 2);
  assert.equal(trace.logs.length, 1);
  assert.equal(trace.service, "demo-agent");
  assert.ok(trace.spans.every((s) => s.traceId === summaryRow.trace_id));
  assert.equal(trace.explanation, undefined);
  assert.equal(trace.k8sEvents, undefined);
});

test("root span name and service backfill a summary whose root has not merged yet", () => {
  const trace = toTrace({ ...summaryRow, root_name: "", root_service: "" }, [spanRow, llmRow], [], []);
  assert.equal(trace.rootName, "POST /chat");
  assert.equal(trace.service, "demo-agent");
});

// D37.4: nearby rows are a second, unrelated read (trace_id always ''), merged
// onto the solid ones. toLogRecord already turns an empty trace_id into
// `traceId: undefined` — the same mapping LOGS_SQL's rows go through — so
// nearby rows need no adapter of their own; these tests pin that behavior at
// the toTrace boundary instead of re-deriving it.
const nearbyLogRow: LogRow = {
  at_offset_ns: "9500000000", // +9.5s: inside the ±10s window, after trace end
  trace_id: "",
  severity_number: 9,
  severity_text: "INFO",
  body: "sidecar: heartbeat",
  k8s_namespace: "obstack",
  k8s_pod: "agent-worker-7d9fb-kx2rq",
  k8s_container: "sidecar",
};

test("nearby rows land as undefined-traceId entries alongside solid ones, with signed offsets preserved", () => {
  const beforeStart: LogRow = { ...nearbyLogRow, at_offset_ns: "-8000000000" }; // -8s, before trace start
  const trace = toTrace(summaryRow, [spanRow], [logRow], [nearbyLogRow, beforeStart]);
  assert.equal(trace.logs.length, 3);
  const solid = trace.logs.filter((l) => l.traceId);
  const nearby = trace.logs.filter((l) => !l.traceId);
  assert.equal(solid.length, 1);
  assert.equal(nearby.length, 2);
  assert.ok(nearby.every((l) => l.traceId === undefined));
  assert.ok(nearby.some((l) => l.atMs === 9500)); // positive: after trace end
  assert.ok(nearby.some((l) => l.atMs === -8000)); // negative: before trace start
});

test("a trace with no nearby rows renders only the solid ones (D13/D21: never invented, never inferred)", () => {
  const trace = toTrace(summaryRow, [spanRow], [logRow], []);
  assert.equal(trace.logs.length, 1);
  assert.equal(trace.logs[0].traceId, summaryRow.trace_id);
});

// `nearbyLogRows` arrives unsliced from `queryTrace` (up to NEARBY_LOG_CAP + 1,
// per NEARBY_LOGS_SQL's `fetch_limit`) — `toTrace` is the one place that both
// slices to the cap and sets `nearbyLogsTruncated`, from the same length check.
const makeNearbyFillers = (count: number): LogRow[] =>
  Array.from({ length: count }, (_, i) => ({
    ...nearbyLogRow,
    at_offset_ns: String(9_500_000_000 + i),
    body: `filler-${i}`,
  }));

test("nearbyLogsTruncated is omitted — never false — at exactly the cap (D13/D21: no unproven claim)", () => {
  const trace = toTrace(summaryRow, [spanRow], [], makeNearbyFillers(NEARBY_LOG_CAP));
  assert.equal("nearbyLogsTruncated" in trace, false);
  assert.equal(trace.logs.length, NEARBY_LOG_CAP);
});

test("nearbyLogsTruncated is true and the render still caps at NEARBY_LOG_CAP when the adapter sees cap+1", () => {
  const trace = toTrace(summaryRow, [spanRow], [], makeNearbyFillers(NEARBY_LOG_CAP + 1));
  assert.equal(trace.nearbyLogsTruncated, true);
  assert.equal(trace.logs.length, NEARBY_LOG_CAP);
});
