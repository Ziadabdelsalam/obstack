import assert from "node:assert/strict";
import test from "node:test";
import type { LogRecord, Span, Trace } from "@/lib/types";
import { NOW } from "@/mock/generate";
import { streamLogs } from "@/mock/logstream";
import { allTraces } from "@/mock/traces";
import { mockLogMatches, mockMatches, mockSearchLogs, mockSearchTraces } from "./data";
import { SEVERITY_ORDER } from "@/lib/logs-filter";
import { pods as infraPods } from "@/mock/infra";
import { LOG_SEARCH_CAP, type LogLine } from "./queries/logs";
import { TRACE_PAGE_SIZE } from "./queries/traces";

// run with: node --conditions=react-server --test src/server/data.test.ts
//
// The mock half of the search contract (search-contract.md): free-text reach
// and semantics for `mockMatches`, the PRD §8 structured filters, the D50 time
// bound against the mock clock, and D44 pagination/ordering/totals for
// `mockSearchTraces`. The live half of every assertion here has a twin in
// traces.integration.test.ts; the parity subtest there proves the two halves
// agree on an equivalent fixture.

function makeSpan(overrides: Partial<Span> & { id: string }): Span {
  return {
    traceId: "t1",
    parentId: null,
    name: "POST /chat",
    layer: "api",
    service: "demo-agent",
    startMs: 0,
    durationMs: 100,
    status: "ok",
    attrs: {},
    ...overrides,
  };
}

function makeLog(overrides: Partial<LogRecord> & { id: string }): LogRecord {
  return {
    traceId: "t1",
    atMs: 1,
    severity: "info",
    body: "an ordinary log line",
    namespace: "ns",
    pod: "pod-1",
    container: "app",
    ...overrides,
  };
}

function makeTrace(overrides: Partial<Trace> & { id: string }): Trace {
  return {
    rootName: "POST /chat",
    method: "POST",
    service: "demo-agent",
    startedAt: new Date(NOW - 60_000).toISOString(),
    durationMs: 100,
    status: "ok",
    spanCount: 1,
    totalTokens: 0,
    costUsd: 0,
    services: ["demo-agent"],
    models: [],
    spans: [],
    logs: [],
    ...overrides,
  };
}

// ---- free text (D45, search-contract.md) ------------------------------------

const reachTrace = makeTrace({
  id: "t-reach",
  spans: [
    makeSpan({ id: "s1", name: "vector-search step" }),
    makeSpan({
      id: "s2",
      layer: "llm",
      llm: {
        model: "gpt-4o-mini",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        prompt: "user: summarize the escalation",
        completion: "the incident stems from a pool exhaustion",
        finishReason: "stop",
      },
    }),
  ],
  logs: [
    makeLog({ id: "l1", body: "cache miss for embedding" }),
    // nearby row: no traceId — OUT of the traces-list reach (trace-carrying only)
    makeLog({ id: "l2", traceId: undefined, body: "sidecar heartbeat nearbyonly" }),
  ],
});

test("free text ANDs whitespace-split terms, each matching any reach field independently", () => {
  assert.equal(mockMatches(reachTrace, "vector-search embedding"), true);
  assert.equal(mockMatches(reachTrace, "  vector-search   embedding  "), true);
  assert.equal(mockMatches(reachTrace, "vector-search doesnotexist"), false);
  assert.equal(mockMatches(reachTrace, ""), true);
});

// The D45 correction this task lands: the old matcher read `llm?.prompt` only.
// Red against that matcher (completion term unfindable), green with the fix.
test("free text reaches llm completion (D45: the mock matcher gains completion)", () => {
  assert.equal(mockMatches(reachTrace, "exhaustion"), true);
  assert.equal(mockMatches(reachTrace, "escalation"), true, "sanity: prompt reach unchanged");
});

test("free text is case-insensitive in both directions", () => {
  assert.equal(mockMatches(reachTrace, "EMBEDDING"), true);
  assert.equal(mockMatches(makeTrace({ id: "t-upper", rootName: "POST /ADMIN" }), "admin"), true);
  // D56: Unicode simple case folding, not just ASCII — the live twin is the
  // café/CAFÉ integration probe (positionCaseInsensitiveUTF8).
  assert.equal(mockMatches(makeTrace({ id: "t-cafe", rootName: "order CAFÉ latte" }), "café"), true);
});

test("nearby (traceId-less) log bodies are OUT of the traces-list reach (contract: trace-carrying rows only)", () => {
  assert.equal(mockMatches(reachTrace, "nearbyonly"), false);
});

// The D45 reach set opens with the summary fields, and nothing else in the
// matcher covers them: every token below lives on exactly one summary field and
// nowhere else in the trace, so deleting that one entry from `mockMatches`'s
// haystack turns exactly one assertion red. The live twin is the
// "D45 summary-field reach" subtest in traces.integration.test.ts.
test("free text reaches the summary fields: root name, trace id, models, services", () => {
  const summaryTrace = makeTrace({
    id: "t-idtok-9f3",
    rootName: "POST /roottok-only",
    service: "svctok-only",
    services: ["svctok-only"],
    models: ["modeltok-only"],
    spans: [makeSpan({ id: "s1", name: "unrelated step" })],
    logs: [makeLog({ id: "l1", body: "unrelated body" })],
  });
  assert.equal(mockMatches(summaryTrace, "roottok-only"), true, "root name is in the reach");
  assert.equal(mockMatches(summaryTrace, "idtok-9f3"), true, "the trace id is in the reach");
  assert.equal(mockMatches(summaryTrace, "modeltok-only"), true, "models are in the reach");
  assert.equal(mockMatches(summaryTrace, "svctok-only"), true, "services are in the reach");
  assert.equal(mockMatches(summaryTrace, "absenttok-only"), false, "control: an unseeded token matches nothing");
});

// ---- structured filters (PRD §8) + time bound (D50) -------------------------

const HOUR = 3_600_000;

/** Every filter probe searches this set; each control row passes without the filter under test. */
const filterSet: Trace[] = [
  makeTrace({ id: "f-base", costUsd: 0.01, models: ["gpt-4o-mini"] }),
  makeTrace({ id: "f-error", status: "error" }),
  makeTrace({ id: "f-slow", durationMs: 10_000 }),
  makeTrace({ id: "f-costly", costUsd: 0.05 }),
  makeTrace({ id: "f-model", models: ["model-probe"] }),
  makeTrace({ id: "f-old", startedAt: new Date(NOW - 7 * HOUR).toISOString() }),
  makeTrace({ id: "f-othersvc", service: "other-svc", services: ["other-svc"] }),
];

const idsOf = (traces: Trace[]): string[] => traces.map((t) => t.id).sort();

test("each structured filter narrows with a control row that would pass without it", () => {
  // no filter: everything inside the default window (f-old is time-excluded, below)
  assert.deepEqual(idsOf(mockSearchTraces(filterSet, {}).traces), [
    "f-base",
    "f-costly",
    "f-error",
    "f-model",
    "f-othersvc",
    "f-slow",
  ]);
  // service: f-othersvc is the control — present above, gone here
  assert.deepEqual(idsOf(mockSearchTraces(filterSet, { service: "demo-agent" }).traces), [
    "f-base",
    "f-costly",
    "f-error",
    "f-model",
    "f-slow",
  ]);
  // status: f-base is the control
  assert.deepEqual(idsOf(mockSearchTraces(filterSet, { status: "error" }).traces), ["f-error"]);
  // duration: f-base (100ms) is the control
  assert.deepEqual(idsOf(mockSearchTraces(filterSet, { minMs: 5000 }).traces), ["f-slow"]);
  // model: f-base (gpt-4o-mini) is the control
  assert.deepEqual(idsOf(mockSearchTraces(filterSet, { model: "model-probe" }).traces), ["f-model"]);
  // cost floor: f-base (0.01) is the control
  assert.deepEqual(idsOf(mockSearchTraces(filterSet, { minCostUsd: 0.03 }).traces), ["f-costly"]);
  // cost ceiling: f-costly (0.05) and f-base (0.01) are the controls
  assert.deepEqual(idsOf(mockSearchTraces(filterSet, { maxCostUsd: 0.005 }).traces), [
    "f-error",
    "f-model",
    "f-othersvc",
    "f-slow",
  ]);
});

test("D50 time bound: 6h default against the mock clock NOW; widening rangeMs readmits the old trace", () => {
  const withDefault = mockSearchTraces(filterSet, {});
  assert.ok(!idsOf(withDefault.traces).includes("f-old"), "a 7h-old trace leaked past the 6h default");
  const widened = mockSearchTraces(filterSet, { rangeMs: 8 * HOUR });
  assert.ok(idsOf(widened.traces).includes("f-old"), "rangeMs did not widen the window");
  assert.equal(widened.total, filterSet.length);
});

// ---- pagination, order, totals (D44) ----------------------------------------

// Same start for every fixture, ids deliberately inserted OUT of order: without
// the trace-id tie-break a stable sort would return insertion order and page 1
// would not be the first 200 ids — the "tie-unstable sort" failure, made
// deterministic.
const pageIds = Array.from(
  { length: TRACE_PAGE_SIZE + 5 },
  (_, i) => `p-${String(i).padStart(3, "0")}`,
);
const shuffled = [...pageIds].reverse();
const pageSet: Trace[] = shuffled.map((id) => makeTrace({ id }));

test("D44 pagination: page 1 is the first TRACE_PAGE_SIZE ids in order, page 2 the disjoint remainder", () => {
  const page1 = mockSearchTraces(pageSet, {});
  assert.equal(page1.traces.length, TRACE_PAGE_SIZE);
  assert.deepEqual(
    page1.traces.map((t) => t.id),
    pageIds.slice(0, TRACE_PAGE_SIZE),
    "equal-start fixtures must order by trace id ascending (the mandatory tie-break)",
  );
  const page2 = mockSearchTraces(pageSet, { page: 2 });
  assert.deepEqual(page2.traces.map((t) => t.id), pageIds.slice(TRACE_PAGE_SIZE));
});

// `pageSet` above shares ONE start across every fixture, so it can only ever
// prove the `, trace_id` tie-break — flipping the comparator's start term left
// it (and the whole suite) green. These three carry DISTINCT starts, with ids
// ordered AGAINST the expected result, so the assertion fails both on an
// ascending start sort and on a tie-break-only sort.
test("D44 order direction: distinct-start traces come back newest-first", () => {
  const distinctStarts: Trace[] = [
    makeTrace({ id: "o-a", startedAt: new Date(NOW - 180_000).toISOString() }),
    makeTrace({ id: "o-b", startedAt: new Date(NOW - 120_000).toISOString() }),
    makeTrace({ id: "o-c", startedAt: new Date(NOW - 60_000).toISOString() }),
  ];
  assert.deepEqual(
    mockSearchTraces(distinctStarts, {}).traces.map((t) => t.id),
    ["o-c", "o-b", "o-a"],
    "start DESCENDING is half the D44 order — an ascending (or id-only) sort returns oldest-first",
  );
});

test("D44 total is a property of the data, not the page: both pages report the full filtered count", () => {
  assert.equal(mockSearchTraces(pageSet, {}).total, pageIds.length);
  assert.equal(mockSearchTraces(pageSet, { page: 2 }).total, pageIds.length);
  assert.equal(mockSearchTraces(pageSet, { page: 9 }).traces.length, 0);
  assert.equal(mockSearchTraces(pageSet, { page: 9 }).total, pageIds.length);
});

// ---- F6/F7: the mock default view survives ----------------------------------

test("mock default unfiltered first page is today's full list (F6/F7: the 6h default empties nothing)", () => {
  const { traces, total } = mockSearchTraces(allTraces, {});
  assert.equal(total, allTraces.length, "the D50 default window dropped mock traces");
  assert.equal(traces.length, allTraces.length);
  assert.deepEqual(
    traces.map((t) => t.id).sort(),
    allTraces.map((t) => t.id).sort(),
  );
});

// ---- /app/logs, the mock half (T3: D48 / D50 / D51(e)) ----------------------
//
// The live twin of every assertion here is `queries/logs.integration.test.ts`;
// its parity subtest pins the two free-text implementations to the same
// verdicts. What only this file can prove is the mock stream itself: that the
// D50 window and the D51(e) rules leave the shipped mock surface intact.

const logLine = (over: Partial<LogLine> & { id: string }): LogLine => ({
  ts: NOW - 60_000,
  severity: "info",
  body: "an ordinary log line",
  pod: "pod-1",
  ...over,
});

// D50's "one product-wide 6h" pin moved to `lib/logs-filter.test.ts` with the
// default itself (D65) — the surface's URL contract owns the label, this file
// owns the mock behaviour.

test("mock logs free text reaches the BODY only (D51(e)), ANDing whitespace-split terms", () => {
  const line = logLine({ id: "l1", body: "cache miss for embedding", pod: "gateway-84c5f-jw6th" });
  assert.equal(mockLogMatches(line, "cache embedding"), true);
  assert.equal(mockLogMatches(line, "  cache   embedding  "), true);
  assert.equal(mockLogMatches(line, "cache doesnotexist"), false);
  assert.equal(mockLogMatches(line, ""), true);
  assert.equal(mockLogMatches(line, "EMBEDDING"), true);
  assert.equal(
    mockLogMatches(logLine({ id: "l2", body: "order CAFÉ latte" }), "café"),
    true,
    "D56: Unicode simple case folding, the mock twin of the positionCaseInsensitiveUTF8 probe",
  );
  // The pod was a free-text field on this surface until D51(e) ruled the reach
  // to be the body: red against the old `body || pod` matcher.
  assert.equal(mockLogMatches(line, "gateway"), false);
});

test("each mock logs filter narrows with a control line that would otherwise pass", () => {
  const all: LogLine[] = [
    logLine({ id: "keep-info", body: "keeper info line" }),
    logLine({ id: "ctl-debug", body: "control debug line", severity: "debug" }),
    logLine({ id: "ctl-pod", body: "control other pod", pod: "pod-2" }),
    logLine({ id: "keep-trace", body: "keeper on trace", traceId: "t1" }),
    logLine({ id: "ctl-old", body: "control out of window", ts: NOW - 7 * 3_600_000 }),
  ];
  const ids = (filter: Parameters<typeof mockSearchLogs>[1]) =>
    mockSearchLogs(all, filter).logs.map((l) => l.id);

  assert.deepEqual(ids({}), ["keep-info", "ctl-debug", "ctl-pod", "keep-trace"]);
  assert.deepEqual(ids({ minSeverity: "info" }), ["keep-info", "ctl-pod", "keep-trace"]);
  assert.deepEqual(ids({ pod: "pod-1" }), ["keep-info", "ctl-debug", "keep-trace"]);
  assert.deepEqual(ids({ onTraceOnly: true }), ["keep-trace"]);
  assert.deepEqual(ids({ q: "keeper" }), ["keep-info", "keep-trace"]);
  assert.deepEqual(ids({ rangeMs: 8 * 3_600_000 }), [
    "keep-info",
    "ctl-debug",
    "ctl-pod",
    "keep-trace",
    "ctl-old",
  ]);
});

test("mock logs pod options describe the window, never the current narrowing", () => {
  const all: LogLine[] = [
    logLine({ id: "a", pod: "pod-b" }),
    logLine({ id: "b", pod: "pod-a" }),
    logLine({ id: "c", pod: "" }),
    logLine({ id: "d", pod: "pod-old", ts: NOW - 7 * 3_600_000 }),
  ];
  assert.deepEqual(mockSearchLogs(all, { pod: "pod-a" }).pods, ["pod-a", "pod-b"]);
  assert.deepEqual(mockSearchLogs(all, { rangeMs: 8 * 3_600_000 }).pods, [
    "pod-a",
    "pod-b",
    "pod-old",
  ]);
});

test("the cap is one slice and a proven fact, in mock mode too (E3)", () => {
  const line = (i: number) => logLine({ id: `c${i}`, body: `line ${i}` });
  const exact = Array.from({ length: LOG_SEARCH_CAP }, (_, i) => line(i));
  assert.equal(mockSearchLogs(exact, {}).logs.length, LOG_SEARCH_CAP);
  assert.equal(
    mockSearchLogs(exact, {}).truncated,
    false,
    "exactly the cap reported as truncated — the flag is a count comparison, not a cap+1 fact",
  );
  const over = [...exact, line(LOG_SEARCH_CAP)];
  assert.equal(mockSearchLogs(over, {}).logs.length, LOG_SEARCH_CAP);
  assert.equal(mockSearchLogs(over, {}).truncated, true);
});

// S2.2 L1 standing guard: the D42 carrier exclusion is a LIVE-only rule because
// the mock stream has no bodyless rows to exclude. That premise is asserted, not
// assumed — a mock that grows carrier rows turns this red instead of quietly
// rendering blank lines on the mock surface.
test("the mock stream carries no bodyless rows, so the D42 carrier rule has no mock counterpart", () => {
  assert.deepEqual(
    streamLogs.filter((l) => !l.body).map((l) => l.id),
    [],
  );
});

test("mock default /app/logs window is today's list: the first cap rows of the stream, unchanged", () => {
  const { logs, truncated, pods, nowMs } = mockSearchLogs(streamLogs, {});
  assert.deepEqual(
    logs.map((l) => l.id),
    streamLogs.slice(0, LOG_SEARCH_CAP).map((l) => l.id),
    "the D50 default window or the severity floor changed what mock mode renders by default",
  );
  assert.equal(truncated, streamLogs.length > LOG_SEARCH_CAP);
  assert.deepEqual(pods, [...new Set(streamLogs.map((l) => l.pod))].sort());
  assert.equal(nowMs, NOW, "mock ages must derive from the mock clock, never the wall clock (F6/F7)");
});

test("SEVERITY_ORDER is the one severity ranking both the SQL and the mock filter index into", () => {
  assert.deepEqual([...SEVERITY_ORDER], ["debug", "info", "warn", "error", "fatal"]);
});

// D61: the infra table deep-links each pod to `/app/logs?pod=<full name>`. That
// link is only honest if the name it sends is a value this surface can filter
// on — free text reads the body only (D51(e)), which is why the old truncated
// `?q=` form was a search for a pod name in message text. Measured in mock mode
// before the fix: 9 of these 12 pods returned nothing; after it, every one of
// them lands on rows. This is the standing guard for that (S2.2 L1): if the two
// mock vocabularies ever drift apart, the link starts returning empty windows
// and this goes red rather than the UI quietly lying.
test("D61: every infra pod deep-link lands on a pod the logs surface actually offers", () => {
  const offered = mockSearchLogs(streamLogs, {}).pods;
  const missing = infraPods.filter((p) => !offered.includes(p.name));
  assert.deepEqual(
    missing.map((p) => p.name),
    [],
    "an infra pod is not in the logs surface's pod options — its `logs` link opens an empty window",
  );
  for (const pod of infraPods) {
    assert.ok(
      mockSearchLogs(streamLogs, { pod: pod.name }).logs.length > 0,
      `the pod filter for ${pod.name} matched no rows, so the infra deep-link renders the empty state`,
    );
  }
});
