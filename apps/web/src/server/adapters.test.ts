import assert from "node:assert/strict";
import test from "node:test";
import { NEARBY_LOG_CAP } from "@/lib/nearby-logs";
import {
  toK8sEvent,
  toLogRecord,
  toSpan,
  toTrace,
  toTraceSummary,
  type K8sEventRow,
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

/** `toSpan`'s event-fill map for the cases that have nothing to fill from. */
const NO_FILL = new Map<string, { prompt?: string; completion?: string }>();

test("span row maps offsets, durations and identity", () => {
  const span = toSpan(spanRow, summaryRow.trace_id, NO_FILL);
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
    NO_FILL,
  );
  assert.equal(span.parentId, "b1");
  assert.equal(span.status, "error");
  assert.equal(span.statusMessage, "boom");
});

test("llm span carries the GenAI columns, response model wins", () => {
  const span = toSpan(llmRow, summaryRow.trace_id, NO_FILL);
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
    toSpan({ ...llmRow, finish_reason, status_code }, "t", NO_FILL)!.llm!.finishReason;
  assert.equal(reason("max_tokens"), "length");
  assert.equal(reason("content_filter"), "truncated");
  assert.equal(reason("end_turn"), "stop");
  assert.equal(reason("something_new"), "stop");
  assert.equal(reason("stop", "error"), "error");
});

test("unclassified layer falls back to other", () => {
  assert.equal(toSpan({ ...spanRow, layer: "other" }, "t", NO_FILL).layer, "other");
  assert.equal(toSpan({ ...spanRow, layer: "wat" }, "t", NO_FILL).layer, "other");
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

test("trace detail stitches spans and logs; with no event rows k8sEvents (and explanation) stay undefined", () => {
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

// T6 (D38 FINAL / D42(d)): read-time coalesce — an LLM span's LlmDetail
// hydrates its prompt/completion from event-derived (log-record) rows sharing
// its span_id when the span's own columns are empty, per field independently,
// earliest-timestamp wins. `logRow` above already carries `at_offset_ns:
// "-2000000"` and no span_id/prompt/completion, so it stays an ordinary log
// throughout this block unless a test overrides those fields explicitly.
const emptyLlmRow: SpanRow = { ...llmRow, span_id: "b5", prompt: "", completion: "" };

const contentCarrier = (overrides: Partial<LogRow>): LogRow => ({
  ...logRow,
  trace_id: summaryRow.trace_id,
  body: "", // content carriers are bodyless by definition (D42(d))
  ...overrides,
});

test("a non-empty span column always wins over event-derived content (red when inverted)", () => {
  const eventRow = contentCarrier({
    at_offset_ns: "1000000",
    span_id: llmRow.span_id,
    prompt: "PROBE:event-prompt-must-lose",
    completion: "PROBE:event-completion-must-lose",
  });
  const trace = toTrace(summaryRow, [llmRow], [eventRow], []);
  const span = trace.spans.find((s) => s.id === llmRow.span_id);
  // llmRow's own prompt/completion ("user: hello" / "hi there") must survive
  // untouched — inverting the precedence (event wins over a populated column)
  // would make this assertion fail.
  assert.equal(span?.llm?.prompt, "user: hello");
  assert.equal(span?.llm?.completion, "hi there");
});

test("empty span columns hydrate from event-derived content, per field independently", () => {
  const promptOnly = contentCarrier({
    at_offset_ns: "1000000",
    span_id: "b5",
    prompt: "PROBE:event-prompt",
  });
  const completionOnly = contentCarrier({
    at_offset_ns: "2000000",
    span_id: "b5",
    completion: "PROBE:event-completion",
  });
  const trace = toTrace(summaryRow, [emptyLlmRow], [promptOnly, completionOnly], []);
  const span = trace.spans.find((s) => s.id === "b5");
  assert.equal(span?.llm?.prompt, "PROBE:event-prompt");
  assert.equal(span?.llm?.completion, "PROBE:event-completion");
});

// The case that separates per-FIELD precedence from per-ROW precedence: the
// span carries a prompt but no completion. An implementation that decided
// "this span has its own content, ignore the event rows" would keep every
// other test in this block green and still be wrong per D42(d) — the empty
// completion column must still take the event-derived fill.
test("precedence is per field, not per row: a span's own prompt survives while its empty completion fills from an event row", () => {
  const promptOnlySpan: SpanRow = { ...llmRow, span_id: "b5", completion: "" };
  const eventRow = contentCarrier({
    at_offset_ns: "1000000",
    span_id: "b5",
    prompt: "PROBE:event-prompt-must-lose",
    completion: "PROBE:event-completion-must-win",
  });
  const trace = toTrace(summaryRow, [promptOnlySpan], [eventRow], []);
  const span = trace.spans.find((s) => s.id === "b5");
  assert.equal(span?.llm?.prompt, "user: hello", "the span's own non-empty prompt column must still win");
  assert.equal(
    span?.llm?.completion,
    "PROBE:event-completion-must-win",
    "an empty completion column must fill from the event row even though the prompt column was populated",
  );
});

test("earliest-timestamp content row wins; a later row for the same field does not displace it (red if it did)", () => {
  const earliest = contentCarrier({ at_offset_ns: "1000000", span_id: "b5", prompt: "PROBE:earliest" });
  const later = contentCarrier({ at_offset_ns: "2000000", span_id: "b5", prompt: "PROBE:later-must-not-win" });
  // logRows arrives timestamp-ordered from LOGS_SQL — pass them in that order.
  const trace = toTrace(summaryRow, [emptyLlmRow], [earliest, later], []);
  const span = trace.spans.find((s) => s.id === "b5");
  assert.equal(span?.llm?.prompt, "PROBE:earliest");
});

test("a content row with a non-empty body renders in the rail as a normal log AND still folds", () => {
  const visible = contentCarrier({
    at_offset_ns: "1000000",
    span_id: "b5",
    prompt: "PROBE:visible-content",
    body: "PROBE:visible-body",
  });
  const trace = toTrace(summaryRow, [emptyLlmRow], [visible], []);
  const span = trace.spans.find((s) => s.id === "b5");
  assert.equal(span?.llm?.prompt, "PROBE:visible-content", "a body-carrying content row must still fold");
  assert.equal(trace.logs.length, 1, "a body-carrying content row must still render in the rail");
  assert.equal(trace.logs[0].body, "PROBE:visible-body");
});

// Probe 4 (D42(e)): removing `isContentCarrier`'s filter in `toTrace` makes
// this assertion fail — `trace.logs.length` would be 2 (the carrier's content
// duplicated alongside the narrative row) instead of 1, and TraceExplorer's
// `nearbyCount`/`solidCount` (both derived from `trace.logs`) would then claim
// a row the fold above already renders as LlmDetail — verified red-then-green
// by commenting out the filter in adapters.ts and re-running this test.
test("content-carrier rows (empty body) are excluded from the rendered logs and therefore from the counter", () => {
  const carrier = contentCarrier({ at_offset_ns: "1000000", span_id: "b5", prompt: "PROBE:carrier-content" });
  const narrative = { ...logRow, trace_id: summaryRow.trace_id, body: "an ordinary log line" };
  const trace = toTrace(summaryRow, [emptyLlmRow], [narrative, carrier], []);
  assert.equal(trace.logs.length, 1, "the bodyless content carrier must not be counted among the rendered logs");
  assert.ok(
    trace.logs.every((l) => l.body !== ""),
    "an empty-body content carrier rendered as a blank rail row",
  );
});

test("orphan content rows (span_id matches no span in this trace) fold nowhere and render nowhere", () => {
  const orphan = contentCarrier({ at_offset_ns: "1000000", span_id: "no-such-span", prompt: "PROBE:orphan" });
  const trace = toTrace(summaryRow, [emptyLlmRow], [orphan], []);
  const span = trace.spans.find((s) => s.id === "b5");
  assert.equal(span?.llm?.prompt, "", "an orphan content row must not fold into an unrelated span");
  assert.equal(trace.logs.length, 0, "an orphan content row must not render in the rail");
});

// Kubernetes events on the infra track: `K8S_EVENTS_SQL` rows (the collector's
// k8s_events receiver, one log record per event) → `Trace.k8sEvents`. The pod
// arrives as the resource attribute `k8s.object.name` and the offset is already
// resolved against the trace's min_start in SQL, so this row shape is not a
// LogRow and gets its own fixture. Dedupe by `k8s.event.uid` is NOT tested here
// because it does not live here: `K8S_EVENTS_SQL`'s `LIMIT 1 BY event_uid` over
// `ORDER BY timestamp` resolves it at the server, so the rows this adapter sees
// are already unique per uid — a TS-side dedupe test would assert a behavior
// this file does not own.
const eventRow: K8sEventRow = {
  event_uid: "b1a7d0c4-5f1e-4a2b-9c33-0d7e6f2a8b41",
  reason: "Unhealthy",
  pod: "agent-worker-7d9fb-kx2rq",
  at_offset_ns: "-1500000000", // -1.5s: inside the window, before the trace started
  severity_number: 13,
  severity_text: "Warn",
  body: "Liveness probe failed: HTTP probe failed with statuscode: 500",
};

test("event rows populate k8sEvents with the pod, the trace-relative offset, the kind and the message", () => {
  const trace = toTrace(summaryRow, [spanRow], [logRow], [], [eventRow]);
  assert.deepEqual(trace.k8sEvents, [
    {
      id: "b1a7d0c4-5f1e-4a2b-9c33-0d7e6f2a8b41",
      atMs: -1500,
      pod: "agent-worker-7d9fb-kx2rq",
      kind: "restart",
      severity: "warn",
      label: "Liveness probe failed: HTTP probe failed with statuscode: 500",
    },
  ]);
  // events are their own field — they must not leak into the logs rail
  assert.equal(trace.logs.length, 1);
});

test("event reasons fold onto the curated kind union, unknown reasons to other", () => {
  const kind = (reason: string) => toK8sEvent({ ...eventRow, reason }).kind;
  assert.equal(kind("OOMKilling"), "oom_kill");
  assert.equal(kind("OOMKilled"), "oom_kill");
  assert.equal(kind("BackOff"), "restart");
  assert.equal(kind("Unhealthy"), "restart");
  assert.equal(kind("Killing"), "restart");
  assert.equal(kind("FailedScheduling"), "other");
  assert.equal(kind("SomeControllerInventedThis"), "other");
  assert.equal(kind(""), "other");
});

test("an OOM kill is fatal whatever the receiver labelled it; other kinds take the row's own severity", () => {
  // the receiver maps event Type "warning" → Warn, so an OOMKilling row arrives
  // at severity_number 13 — the trace timeline still calls it fatal.
  const oom = toK8sEvent({ ...eventRow, reason: "OOMKilling", severity_number: 13, severity_text: "Warn" });
  assert.equal(oom.kind, "oom_kill");
  assert.equal(oom.severity, "fatal");
  assert.equal(toK8sEvent({ ...eventRow, severity_number: 9, severity_text: "Info" }).severity, "info");
  assert.equal(toK8sEvent({ ...eventRow, severity_number: 13 }).severity, "warn");
  // no error member on K8sEvent["severity"]: anything above WARN folds to warn,
  // it does not silently downgrade to info
  assert.equal(toK8sEvent({ ...eventRow, severity_number: 17 }).severity, "warn");
});

test("a bodyless event falls back to its reason so the marker still says what it was", () => {
  assert.equal(toK8sEvent({ ...eventRow, body: "" }).label, "Unhealthy");
});

test("the offset is rounded to whole milliseconds", () => {
  assert.equal(toK8sEvent({ ...eventRow, at_offset_ns: "1500400" }).atMs, 2);
  assert.equal(toK8sEvent({ ...eventRow, at_offset_ns: "1400400" }).atMs, 1);
});

test("no event rows omits the k8sEvents key entirely — never an empty array (D208: no false capability claim)", () => {
  const trace = toTrace(summaryRow, [spanRow], [logRow], [], []);
  assert.equal("k8sEvents" in trace, false, "an empty array here would earn Waterfall's '& k8s events' heading");
  // the default parameter must produce the same absence for the call sites that
  // predate events (queryTrace skips the query outright for non-k8s traces)
  assert.equal("k8sEvents" in toTrace(summaryRow, [spanRow], [logRow], []), false);
});

test("coalesce disabled leaves an event-form-only trace with an empty prompt, proving the fill is real", () => {
  const eventOnlyLog = contentCarrier({ at_offset_ns: "1000000", span_id: "b5", prompt: "PROBE:event-only-prompt" });

  // "coalesce disabled": handing toSpan an empty fill map (as toTrace never
  // does — it always builds the real one) is the literal disabled state.
  const withoutCoalesce = toSpan(emptyLlmRow, summaryRow.trace_id, NO_FILL);
  assert.equal(withoutCoalesce.llm?.prompt, "", "sanity: with no fill supplied there is nothing to show");

  // toTrace always builds and passes the fill map — the same span, read
  // through the real path, must come back hydrated.
  const trace = toTrace(summaryRow, [emptyLlmRow], [eventOnlyLog], []);
  const span = trace.spans.find((s) => s.id === "b5");
  assert.equal(span?.llm?.prompt, "PROBE:event-only-prompt");
});
