import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";
import { NEARBY_LOG_CAP } from "@/lib/nearby-logs";
// type-only: erased at runtime, so it cannot run ahead of the env setup below
import type { Span } from "@/lib/types";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait clickhouse
// then:     npm test --workspace apps/web
// (down -v first for a clean volume — see deploy/compose/README.md)
//
// This is the seeded-ClickHouse half of T3's nearby-logs done-check (D37.4,
// kickoff Decisions 3-5). The WHERE clause NEARBY_LOGS_SQL builds — the pod/
// namespace subquery, the window bound, the `trace_id = ''` restriction — is
// real SQL that a pure adapter unit test (adapters.test.ts) cannot exercise;
// only a real server can prove it.
//
// It skips when no ClickHouse answers, like services/ingest's
// integration_test.go — and, since T3's E1 escalation landed on T5, the same
// full precedent now holds on both checks: `web` brings up the compose
// ClickHouse (plus `ingest`, the schema owner) before `npm test` and then
// FAILS the job on any unexpected skip (.github/workflows/web.yml, "D36 skip
// trap", mirroring go.yml's), so this file executes on every PR and cannot go
// quietly green by skipping.
//
// Env vars mirror deploy/compose/README.md's live-mode block exactly
// (CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD) so this reads
// through `queryTrace` with the same client the app uses — nothing here talks
// to ClickHouse through a side channel except the ingest-privileged seeding
// client, which stands in for the writer this sprint does not touch.

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const WEB_USER = process.env.CLICKHOUSE_USER ?? "obstack_web";
const WEB_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "obstack_web_dev";
const INGEST_PASSWORD =
  process.env.OBSTACK_TEST_CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";

// `queryTrace` (imported below) reads these lazily on its first query, inside
// `@/server/clickhouse.ts`'s `getClient()` — set before any test runs so that
// first call resolves to this ClickHouse instead of throwing.
process.env.CLICKHOUSE_URL = CLICKHOUSE_URL;
process.env.CLICKHOUSE_USER = WEB_USER;
process.env.CLICKHOUSE_PASSWORD = WEB_PASSWORD;

const seed = createClient({
  url: CLICKHOUSE_URL,
  username: "obstack_ingest",
  password: INGEST_PASSWORD,
  database: "obstack",
});

async function clickhouseReachable(): Promise<boolean> {
  try {
    return (await seed.ping()).success;
  } catch {
    return false;
  }
}

/**
 * A workspace of this run's own, not the compose dev default `ws_demo`: this
 * file seeds rows it cannot delete (the ingest user has no mutation grant), and
 * a synthetic trace injected into `ws_demo` would show up in the demo UI and in
 * whatever the sprint's evidence runs count there. `@/server/clickhouse.ts`
 * reads OBSTACK_WORKSPACE_ID at module load, so it is set before `./traces` is
 * imported below.
 */
const WORKSPACE_ID = `ws_it_${randomBytes(4).toString("hex")}`;
process.env.OBSTACK_WORKSPACE_ID = WORKSPACE_ID;

// BigInt literal syntax (`123n`) needs an ES2020 target; tsconfig.json pins
// ES2017, so every constant here goes through the `BigInt(...)` call form
// instead — same runtime value, no down-level syntax error.
const NS_PER_SECOND = BigInt(1_000_000_000);
const NS_PER_MS = BigInt(1_000_000);

/** DateTime64(9,'UTC') wants `'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'`; a JS `Date` tops out at millisecond precision and would silently truncate the offsets under test. */
function chTimestamp(epochNs: bigint): string {
  const seconds = epochNs / NS_PER_SECOND;
  const nanos = epochNs % NS_PER_SECOND;
  const isoSeconds = new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
  return `${isoSeconds}.${nanos.toString().padStart(9, "0")}`;
}

function spanRow(overrides: {
  trace_id: string;
  span_id: string;
  start_time: string;
  duration_ns: string;
  k8s_namespace: string;
  k8s_pod: string;
  parent_span_id?: string;
  name?: string;
  service?: string;
  status_code?: string;
  cost_usd?: number;
  layer?: string;
  gen_ai_request_model?: string;
  gen_ai_response_model?: string;
  prompt?: string;
  completion?: string;
}) {
  return {
    workspace_id: WORKSPACE_ID,
    parent_span_id: "",
    name: "POST /chat",
    kind: "server",
    service: "demo-agent-it",
    status_code: "ok",
    status_message: "",
    layer: "api",
    gen_ai_system: "",
    gen_ai_request_model: "",
    gen_ai_response_model: "",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    finish_reason: "",
    prompt: "",
    completion: "",
    k8s_container: "app",
    k8s_node: "",
    attributes: {},
    resource_attributes: {},
    ...overrides,
  };
}

function logRow(overrides: {
  trace_id: string;
  timestamp: string;
  body: string;
  k8s_namespace: string;
  k8s_pod: string;
  span_id?: string;
  prompt?: string;
  completion?: string;
}) {
  return {
    workspace_id: WORKSPACE_ID,
    span_id: "",
    severity_number: 9,
    severity_text: "INFO",
    service: "demo-agent-it",
    k8s_container: "sidecar",
    prompt: "",
    completion: "",
    attributes: {},
    resource_attributes: {},
    ...overrides,
  };
}

test("nearby-logs join (D37.4) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(
      `no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`,
    );
    return;
  }

  const { queryTrace } = await import("./traces");

  const suffix = randomBytes(6).toString("hex");
  const traceId = `it_nearby_${suffix}`;
  const foreignTraceId = `it_foreign_${suffix}`;
  const noPodTraceId = `it_nopod_${suffix}`;
  const namespace = `it-ns-${suffix}`;
  const pod = `it-pod-${suffix}`;
  const otherPod = `it-otherpod-${suffix}`;

  const windowNs = BigInt(10) * NS_PER_SECOND; // NEARBY_LOG_WINDOW_NS — pinned literally so this test fails if the constant ever drifts silently
  const t0 = BigInt(Date.now()) * NS_PER_MS; // trace start, epoch ns
  const durationNs = BigInt(5) * NS_PER_SECOND; // 5s span
  const t1 = t0 + durationNs; // trace end (max_end)

  await seed.insert({
    table: "spans",
    format: "JSONEachRow",
    values: [
      spanRow({
        trace_id: traceId,
        span_id: "s1",
        start_time: chTimestamp(t0),
        duration_ns: durationNs.toString(),
        k8s_namespace: namespace,
        k8s_pod: pod,
      }),
      // A trace with NO pod metadata at all — the shape every non-k8s sender
      // produces (the compose demo path today). Its nearby set must be empty:
      // an empty pod is absence of a join key, not a key that matches every
      // other pod-less log in the workspace.
      spanRow({
        trace_id: noPodTraceId,
        span_id: "s1",
        start_time: chTimestamp(t0),
        duration_ns: durationNs.toString(),
        k8s_namespace: "",
        k8s_pod: "",
      }),
    ],
  });

  const nearbyBefore = "PROBE:nearby-before-start";
  const nearbyAfter = "PROBE:nearby-after-end";
  const differentPodBody = "PROBE:different-pod";
  const outsideWindowBody = "PROBE:outside-window";
  const foreignTraceBody = "PROBE:foreign-trace-id";
  const noPodBody = `PROBE:no-pod-metadata ${suffix}`;

  await seed.insert({
    table: "logs",
    format: "JSONEachRow",
    values: [
      // inside the window, before trace start — must appear, negative atMs
      logRow({
        trace_id: "",
        timestamp: chTimestamp(t0 - windowNs / BigInt(2)),
        body: nearbyBefore,
        k8s_namespace: namespace,
        k8s_pod: pod,
      }),
      // inside the window, after trace end — must appear, positive atMs
      logRow({
        trace_id: "",
        timestamp: chTimestamp(t1 + windowNs / BigInt(2)),
        body: nearbyAfter,
        k8s_namespace: namespace,
        k8s_pod: pod,
      }),
      // probe 1: same window, different pod — must NOT appear
      logRow({
        trace_id: "",
        timestamp: chTimestamp(t0 + NS_PER_SECOND),
        body: differentPodBody,
        k8s_namespace: namespace,
        k8s_pod: otherPod,
      }),
      // probe 2: same pod, outside the window on both sides — must NOT appear
      logRow({
        trace_id: "",
        timestamp: chTimestamp(t0 - windowNs - BigInt(5) * NS_PER_SECOND),
        body: outsideWindowBody,
        k8s_namespace: namespace,
        k8s_pod: pod,
      }),
      // probe 3: same pod, inside the window, but carries a (foreign) trace_id — must NOT appear in this trace's nearby set
      logRow({
        trace_id: foreignTraceId,
        timestamp: chTimestamp(t0 + NS_PER_SECOND),
        body: foreignTraceBody,
        k8s_namespace: namespace,
        k8s_pod: pod,
      }),
      // probe 4: trace-less AND pod-less, inside the window — the shape most
      // rows in a non-k8s deployment have. Must NOT appear for the pod-less
      // trace (nor for any other), or `''` becomes a wildcard join key.
      logRow({
        trace_id: "",
        timestamp: chTimestamp(t0 + NS_PER_SECOND),
        body: noPodBody,
        k8s_namespace: "",
        k8s_pod: "",
      }),
    ],
  });

  const trace = await queryTrace(traceId);
  assert.ok(trace, "queryTrace found no row for the seeded trace");

  const bodies = trace.logs.map((l) => l.body);
  const byBody = new Map(trace.logs.map((l) => [l.body, l]));

  await t.test("logs inside the window on the trace's pod land as nearby, signed atMs preserved", () => {
    const before = byBody.get(nearbyBefore);
    const after = byBody.get(nearbyAfter);
    assert.ok(before, "log before trace start, inside the window, did not resolve as nearby");
    assert.ok(after, "log after trace end, inside the window, did not resolve as nearby");
    assert.equal(before!.traceId, undefined);
    assert.equal(after!.traceId, undefined);
    assert.ok(before!.atMs < 0, `expected a negative atMs for a before-start nearby log, got ${before!.atMs}`);
    assert.ok(after!.atMs > 0, `expected a positive atMs for an after-end nearby log, got ${after!.atMs}`);
  });

  await t.test("falsification probe: a log from a different pod stays out of the nearby set", () => {
    assert.ok(
      !bodies.includes(differentPodBody),
      "a log from a different pod leaked into this trace's nearby logs",
    );
  });

  await t.test("falsification probe: a log outside the window stays out of the nearby set", () => {
    assert.ok(
      !bodies.includes(outsideWindowBody),
      "a log outside the ±window leaked into this trace's nearby logs",
    );
  });

  await t.test("falsification probe: a log carrying a (foreign) trace_id stays out of the nearby set", () => {
    assert.ok(
      !bodies.includes(foreignTraceBody),
      "a log carrying another trace's trace_id leaked into this trace's nearby logs",
    );
  });

  await t.test("falsification probe: a trace whose spans carry no pod joins nothing", async () => {
    const noPodTrace = await queryTrace(noPodTraceId);
    assert.ok(noPodTrace, "queryTrace found no row for the pod-less trace");
    assert.deepEqual(
      noPodTrace.logs.map((l) => l.body),
      [],
      "a trace with no pod metadata pulled in nearby logs — empty k8s_pod is matching as a join key",
    );
    assert.ok(
      !bodies.includes(noPodBody),
      "a pod-less log leaked into the pod-carrying trace's nearby logs",
    );
  });

  // E2: a chatty pod files NEARBY_LOG_CAP + 1 trace-less rows in the window
  // (one more than the query fetches, `NEARBY_LOG_CAP + 1`, so ordering alone
  // decides which are dropped), all chronologically before one row that lands
  // inside the trace's own [min_start, max_end] interval. Under a bare
  // `ORDER BY timestamp LIMIT fetch_limit` the chatty filler alone fills the
  // fetch and the in-interval row never survives selection; proximity rank (0
  // for anything in-interval) always sorts it first regardless of filler
  // count. This subtest seeds its own trace/pod so it cannot perturb the
  // counts asserted above.
  await t.test("falsification probe (E2): a chatty pod cannot evict an in-interval row from the cap", async () => {
    const chattyId = `it_chatty_${suffix}`;
    const chattyPod = `it-chattypod-${suffix}`;
    const chattyStart = t0 + BigInt(3_600) * NS_PER_SECOND; // offset well clear of the main trace's own window
    const chattyDuration = durationNs;
    const inIntervalBody = `PROBE:chatty-in-interval ${suffix}`;

    await seed.insert({
      table: "spans",
      format: "JSONEachRow",
      values: [
        spanRow({
          trace_id: chattyId,
          span_id: "s1",
          start_time: chTimestamp(chattyStart),
          duration_ns: chattyDuration.toString(),
          k8s_namespace: namespace,
          k8s_pod: chattyPod,
        }),
      ],
    });

    const fillers = Array.from({ length: NEARBY_LOG_CAP + 1 }, (_, i) =>
      logRow({
        trace_id: "",
        // chronologically before chattyStart, spaced 1ms apart, all inside the
        // ±window but outside [chattyStart, chattyStart+duration] — so every
        // filler has a strictly positive proximity rank.
        timestamp: chTimestamp(chattyStart - windowNs + BigInt(i) * NS_PER_MS),
        body: `PROBE:chatty-filler-${i} ${suffix}`,
        k8s_namespace: namespace,
        k8s_pod: chattyPod,
      }),
    );
    const inIntervalRow = logRow({
      trace_id: "",
      timestamp: chTimestamp(chattyStart + BigInt(2) * NS_PER_SECOND), // inside [chattyStart, chattyStart+5s] — proximity rank 0
      body: inIntervalBody,
      k8s_namespace: namespace,
      k8s_pod: chattyPod,
    });
    await seed.insert({ table: "logs", format: "JSONEachRow", values: [...fillers, inIntervalRow] });

    const chattyTrace = await queryTrace(chattyId);
    assert.ok(chattyTrace, "queryTrace found no row for the chatty-pod trace");
    assert.ok(
      chattyTrace.logs.some((l) => l.body === inIntervalBody),
      `the in-interval row was evicted by ${NEARBY_LOG_CAP} chronologically-earlier filler rows — selection is not proximity-ranked`,
    );
    // E3: the same fixture has NEARBY_LOG_CAP + 1 real candidates — the render
    // must still cap at exactly NEARBY_LOG_CAP; the extra fetched row proves
    // truncation internally but is never one of the rows returned.
    assert.equal(
      chattyTrace.logs.length,
      NEARBY_LOG_CAP,
      `queryTrace returned ${chattyTrace.logs.length} nearby rows for a fixture with ${NEARBY_LOG_CAP + 1} real candidates — the cap+1 fetch is leaking past the slice`,
    );
    // The only end-to-end check that the SQL really fetches NEARBY_LOG_CAP + 1:
    // with a `fetch_limit` of NEARBY_LOG_CAP the adapter would never see the
    // extra row, so the flag would be silently unreachable in production while
    // every unit test (which hands `toTrace` the cap+1 array directly) stayed
    // green.
    assert.equal(
      chattyTrace.nearbyLogsTruncated,
      true,
      "a window with more candidates than the cap did not report nearbyLogsTruncated — the query is not fetching one past the cap",
    );
  });
});

// T6 (D38 FINAL / D42(d)): read-time coalesce. `adapters.test.ts` proves the
// precedence logic against fabricated LogRow objects; this proves LOGS_SQL
// itself actually selects span_id/prompt/completion from a real server and
// that the whole read (SQL -> adapter) produces the right LlmDetail and rail —
// a fabricated LogRow cannot exercise the SELECT list at all.
test("read-time coalesce (D42(d)) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(
      `no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`,
    );
    return;
  }

  const { queryTrace } = await import("./traces");

  const suffix = randomBytes(6).toString("hex");
  const traceId = `it_coalesce_${suffix}`;
  const llmSpanId = "llm1";
  const t0 = BigInt(Date.now()) * NS_PER_MS;
  const spanDurationNs = NS_PER_SECOND;

  const earliestPrompt = `PROBE:earliest-prompt ${suffix}`;
  const laterPrompt = `PROBE:later-prompt-must-not-win ${suffix}`;
  const completionText = `PROBE:completion ${suffix}`;
  const visibleBody = `PROBE:visible-content-row ${suffix}`;
  const visiblePromptLoses = `PROBE:visible-row-prompt-must-not-win ${suffix}`;
  const orphanContent = `PROBE:orphan-content ${suffix}`;
  const narrativeBody = `PROBE:ordinary-log-line ${suffix}`;

  await seed.insert({
    table: "spans",
    format: "JSONEachRow",
    values: [
      spanRow({
        trace_id: traceId,
        span_id: "root",
        start_time: chTimestamp(t0),
        duration_ns: (spanDurationNs * BigInt(3)).toString(),
        k8s_namespace: "",
        k8s_pod: "",
      }),
      // The LLM span's own prompt/completion columns stay empty (as an
      // event-form-only producer would leave them) — the read must fill both
      // from the log rows below.
      spanRow({
        trace_id: traceId,
        span_id: llmSpanId,
        parent_span_id: "root",
        start_time: chTimestamp(t0 + spanDurationNs),
        duration_ns: spanDurationNs.toString(),
        k8s_namespace: "",
        k8s_pod: "",
        layer: "llm",
        gen_ai_request_model: "gpt-4o-mini",
        gen_ai_response_model: "gpt-4o-mini",
        prompt: "",
        completion: "",
      }),
    ],
  });

  await seed.insert({
    table: "logs",
    format: "JSONEachRow",
    values: [
      // earliest prompt-only content carrier — must win the fold (empty body)
      logRow({
        trace_id: traceId,
        timestamp: chTimestamp(t0 + spanDurationNs),
        body: "",
        k8s_namespace: "",
        k8s_pod: "",
        span_id: llmSpanId,
        prompt: earliestPrompt,
      }),
      // later prompt-only row for the same span — must NOT displace the earliest
      logRow({
        trace_id: traceId,
        timestamp: chTimestamp(t0 + spanDurationNs + NS_PER_MS),
        body: "",
        k8s_namespace: "",
        k8s_pod: "",
        span_id: llmSpanId,
        prompt: laterPrompt,
      }),
      // completion-only content carrier, folds independently of the prompt field
      logRow({
        trace_id: traceId,
        timestamp: chTimestamp(t0 + spanDurationNs + BigInt(2) * NS_PER_MS),
        body: "",
        k8s_namespace: "",
        k8s_pod: "",
        span_id: llmSpanId,
        completion: completionText,
      }),
      // a content row that ALSO carries a body: renders in the rail as a
      // normal log AND still competes for the fold (loses — later than the
      // earliest prompt row above).
      logRow({
        trace_id: traceId,
        timestamp: chTimestamp(t0 + spanDurationNs + BigInt(3) * NS_PER_MS),
        body: visibleBody,
        k8s_namespace: "",
        k8s_pod: "",
        span_id: llmSpanId,
        prompt: visiblePromptLoses,
      }),
      // an ordinary narrative log, unaffected by any of this
      logRow({
        trace_id: traceId,
        timestamp: chTimestamp(t0),
        body: narrativeBody,
        k8s_namespace: "",
        k8s_pod: "",
      }),
      // orphan content row: span_id matches nothing in this trace — folds
      // nowhere (no span to fill) and renders nowhere (bodyless carrier).
      logRow({
        trace_id: traceId,
        timestamp: chTimestamp(t0 + spanDurationNs),
        body: "",
        k8s_namespace: "",
        k8s_pod: "",
        span_id: "no-such-span",
        prompt: orphanContent,
      }),
    ],
  });

  const trace = await queryTrace(traceId);
  assert.ok(trace, "queryTrace found no row for the seeded trace");
  const llmSpan = trace.spans.find((s) => s.id === llmSpanId);
  assert.ok(llmSpan?.llm, "the LLM span did not carry an llm detail");

  await t.test("empty span columns hydrate from the earliest-timestamp event-derived row, per field", () => {
    assert.equal(llmSpan!.llm!.prompt, earliestPrompt);
    assert.equal(llmSpan!.llm!.completion, completionText);
  });

  await t.test("a later content row never displaces the earliest fill (red if it did)", () => {
    assert.notEqual(llmSpan!.llm!.prompt, laterPrompt);
    assert.notEqual(llmSpan!.llm!.prompt, visiblePromptLoses);
  });

  await t.test("bodyless content carriers and orphan rows are invisible in the rail; a body-carrying content row still renders", () => {
    const bodies = trace.logs.map((l) => l.body);
    assert.ok(bodies.includes(narrativeBody), "the ordinary narrative log dropped out of the rail");
    assert.ok(bodies.includes(visibleBody), "the body-carrying content row must still render");
    assert.ok(!bodies.includes(orphanContent), "an orphan content row rendered despite matching no span");
    assert.ok(
      trace.logs.every((l) => l.body !== ""),
      "an empty-body content carrier rendered as a blank rail row",
    );
    // Probe 4: exactly the two non-carrier rows render — a regression that
    // dropped the isContentCarrier filter would show all five logs rows here
    // instead, duplicating the folded content into the rail.
    assert.equal(trace.logs.length, 2, `expected 2 rendered rows (narrative + visible), got ${trace.logs.length}`);
  });

  // D42(d) says earliest-timestamp wins and says it is DETERMINISTIC. Equal
  // timestamps are the case that tests that claim: `obstack.logs` has no unique
  // key, so under a bare `ORDER BY timestamp` the winner is whichever row the
  // storage happens to hand back first — insertion order inside a part, and a
  // DIFFERENT order once ClickHouse merges parts, i.e. the rendered prompt
  // would change on its own with no new data. LOGS_SQL therefore tie-breaks on
  // `span_id, prompt, completion`. Rows arrive here in one batch in reverse
  // tiebreak order, which is exactly the physical order a non-total sort would
  // return: drop the tiebreak and this assertion reads the second value.
  await t.test("two content rows at the SAME timestamp resolve deterministically, not by physical order", async () => {
    const tieTraceId = `it_coalesce_tie_${suffix}`;
    const tieTs = chTimestamp(t0);
    const tieWinner = `PROBE:aaa-tie-winner ${suffix}`;
    const tieLoser = `PROBE:zzz-tie-loser ${suffix}`;

    await seed.insert({
      table: "spans",
      format: "JSONEachRow",
      values: [
        spanRow({
          trace_id: tieTraceId,
          span_id: llmSpanId,
          start_time: tieTs,
          duration_ns: spanDurationNs.toString(),
          k8s_namespace: "",
          k8s_pod: "",
          layer: "llm",
          gen_ai_request_model: "gpt-4o-mini",
          gen_ai_response_model: "gpt-4o-mini",
        }),
      ],
    });
    await seed.insert({
      table: "logs",
      format: "JSONEachRow",
      values: [
        logRow({ trace_id: tieTraceId, timestamp: tieTs, body: "", k8s_namespace: "", k8s_pod: "", span_id: llmSpanId, prompt: tieLoser }),
        logRow({ trace_id: tieTraceId, timestamp: tieTs, body: "", k8s_namespace: "", k8s_pod: "", span_id: llmSpanId, prompt: tieWinner }),
      ],
    });

    const tieTrace = await queryTrace(tieTraceId);
    assert.ok(tieTrace, "queryTrace found no row for the tie trace");
    assert.equal(
      tieTrace.spans.find((s) => s.id === llmSpanId)?.llm?.prompt,
      tieWinner,
      "same-timestamp content rows folded by physical row order — LOGS_SQL's ORDER BY is not total, so this trace's prompt can change after a merge",
    );
  });
});

// T1 (D44/D45/D50): the live half of the search contract (search-contract.md)
// against a real server — pagination and the exact filtered total, the PRD §8
// structured filters, the free-text semi-join legs, and the D50 time bound.
// Every probe set here is scoped to this run's own tokens/services, so the
// rows the earlier tests seeded into the shared workspace can never satisfy or
// pollute an assertion. The mock half of every assertion lives in
// data.test.ts; the parity subtest at the bottom pins the two halves to the
// same verdicts over an equivalent fixture (D13: one contract).
test("trace search (D44/D45) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(
      `no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`,
    );
    return;
  }

  const { queryTraceSearch, TRACE_PAGE_SIZE } = await import("./traces");
  const { mockMatches } = await import("@/server/data");

  const suffix = randomBytes(6).toString("hex");
  const HOUR_MS = 3_600_000;
  const nowMs = Date.now();

  // ---- D44: pagination, deterministic order, the exact filtered total ------
  // One page plus five, ALL at the same start_time: with min(min_start) equal
  // across the whole set, only the mandatory trace_id tie-break can order the
  // pages — under a bare `ORDER BY min(min_start) DESC` the page boundary is
  // physical-order luck and the exact-sequence assertions below go red.
  const PAGE_SVC = `svc-page-${suffix}`;
  const pageCount = TRACE_PAGE_SIZE + 5;
  const pageIds = Array.from(
    { length: pageCount },
    (_, i) => `it_page_${suffix}_${String(i).padStart(3, "0")}`,
  );
  const pageStart = chTimestamp(BigInt(nowMs) * NS_PER_MS);

  // ---- PRD §8 filter probes: one control row per filter --------------------
  // Every filt trace's root name carries FILT_TOKEN, so `q: FILT_TOKEN` scopes
  // each probe to exactly this set; the excluded control re-appearing means the
  // clause under test was dropped.
  const FILT_TOKEN = `filtprobe${suffix}`;
  const FILT_SVC = `svc-filt-${suffix}`;
  const OTHER_SVC = `svc-other-${suffix}`;
  const MODEL_PROBE = `model-probe-${suffix}`;

  // ---- D44 order DIRECTION: start DESCENDING ------------------------------
  // The page fixture below shares ONE start time across all 205 rows, so it can
  // only ever prove the `, trace_id` tie-break — flipping `DESC` to `ASC` left
  // it (and the whole suite) green. These three carry DISTINCT starts and ids
  // ordered AGAINST the expected result, so the assertion fails under `ASC` and
  // under a tie-break-only sort alike.
  const ORDER_SVC = `svc-order-${suffix}`;
  const orderIds = ["a", "b", "c"].map((k) => `it_ord_${k}_${suffix}`);
  const orderStartsMs = [nowMs - 180_000, nowMs - 120_000, nowMs - 60_000]; // a oldest … c newest
  const filtId = (k: string) => `it_filt_${k}_${suffix}`;
  const filtSpan = (
    k: string,
    over: { service?: string; status_code?: string; cost_usd?: number; duration_s?: number; gen_ai_request_model?: string; start_ms?: number },
  ) =>
    spanRow({
      trace_id: filtId(k),
      span_id: "s1",
      name: `POST /probe ${FILT_TOKEN}`,
      service: over.service ?? FILT_SVC,
      status_code: over.status_code,
      cost_usd: over.cost_usd,
      gen_ai_request_model: over.gen_ai_request_model,
      start_time: chTimestamp(BigInt(over.start_ms ?? nowMs) * NS_PER_MS),
      duration_ns: (BigInt(over.duration_s ?? 1) * NS_PER_SECOND).toString(),
      k8s_namespace: "",
      k8s_pod: "",
    });

  // ---- D45 free-text legs + parity fixture ---------------------------------
  const rootTok = `zqroot${suffix}`; // summary leg: root name
  const tokSpanName = `zqspanname${suffix}`; // spans leg: child span name
  const tokPrompt = `zqprompt${suffix}`; // spans leg: prompt column
  const tokCompletion = `zqcompletion${suffix}`; // spans leg: completion column
  const tokBody = `zqbody${suffix}`; // logs leg: narrative body
  const tokCarrierP = `zqcarrierp${suffix}`; // logs leg: D42 carrier prompt
  const tokCarrierC = `zqcarrierc${suffix}`; // logs leg: D42 carrier completion
  const tokTraceless = `zqtraceless${suffix}`; // trace-less row: reachable by NO traces-list query
  const tokAbsent = `zqabsent${suffix}`; // seeded nowhere
  // D56: the SAME word, case-differing on its non-ASCII letter. ASCII folding
  // (positionCaseInsensitive) folds c/a/f but not É→é, so only Unicode folding
  // (positionCaseInsensitiveUTF8) matches the pair; mock's toLowerCase always
  // could — this is the probe that keeps the one-contract claim true beyond
  // ASCII.
  const tokCafeSeeded = `CAFÉ-${suffix}`; // seeded in SPANLEG's span prompt
  const tokCafeQuery = `café-${suffix}`; // the query form
  const SPANLEG = `it_srch_span_${suffix}`;
  const LOGLEG = `it_srch_log_${suffix}`;
  const srchStart = chTimestamp(BigInt(nowMs) * NS_PER_MS);

  await seed.insert({
    table: "spans",
    format: "JSONEachRow",
    values: [
      ...pageIds.map((id) =>
        spanRow({
          trace_id: id,
          span_id: "s1",
          service: PAGE_SVC,
          start_time: pageStart,
          duration_ns: NS_PER_SECOND.toString(),
          k8s_namespace: "",
          k8s_pod: "",
        }),
      ),
      ...orderIds.map((id, i) =>
        spanRow({
          trace_id: id,
          span_id: "s1",
          service: ORDER_SVC,
          start_time: chTimestamp(BigInt(orderStartsMs[i]) * NS_PER_MS),
          duration_ns: NS_PER_SECOND.toString(),
          k8s_namespace: "",
          k8s_pod: "",
        }),
      ),
      // A summary row at `trace_id = ''`: `trace_summaries` is fed by a
      // materialized view with NO write-side trace-id filter, so a span that
      // arrives without a trace id really does produce one (verified against a
      // live server). This row is what makes the logs leg's `trace_id != ''`
      // falsifiable — see the trace-less subtest below. Its name and service
      // are deliberately neutral so it cannot satisfy any other probe here.
      spanRow({
        trace_id: "",
        span_id: "s1",
        name: "POST /orphan-no-trace-id",
        start_time: srchStart,
        duration_ns: NS_PER_SECOND.toString(),
        k8s_namespace: "",
        k8s_pod: "",
      }),
      filtSpan("a", { cost_usd: 0.01, gen_ai_request_model: "gpt-4o-mini" }),
      filtSpan("b", { status_code: "error" }),
      filtSpan("c", { duration_s: 10 }),
      filtSpan("d", { cost_usd: 0.05 }),
      filtSpan("e", { gen_ai_request_model: MODEL_PROBE }),
      filtSpan("f", { start_ms: nowMs - 7 * HOUR_MS }), // outside the 6h default window
      filtSpan("g", { service: OTHER_SVC }),
      // SPANLEG: every token lives on SPAN rows only — root name in the
      // summary, the rest reachable through the spans semi-join alone.
      spanRow({
        trace_id: SPANLEG,
        span_id: "root",
        name: `POST /${rootTok}`,
        start_time: srchStart,
        duration_ns: NS_PER_SECOND.toString(),
        k8s_namespace: "",
        k8s_pod: "",
      }),
      spanRow({
        trace_id: SPANLEG,
        span_id: "llm1",
        parent_span_id: "root",
        name: `chat ${tokSpanName}`,
        layer: "llm",
        gen_ai_request_model: "gpt-4o-mini",
        gen_ai_response_model: "gpt-4o-mini",
        prompt: `user: hello ${tokPrompt} order ${tokCafeSeeded} latte`,
        completion: `assistant: ${tokCompletion}`,
        start_time: srchStart,
        duration_ns: NS_PER_SECOND.toString(),
        k8s_namespace: "",
        k8s_pod: "",
      }),
      // LOGLEG: an event-form-only trace — its LLM span's own columns are
      // empty; every token lives on LOG rows only (logs semi-join alone).
      spanRow({
        trace_id: LOGLEG,
        span_id: "root",
        name: "POST /worker",
        start_time: srchStart,
        duration_ns: NS_PER_SECOND.toString(),
        k8s_namespace: "",
        k8s_pod: "",
      }),
      spanRow({
        trace_id: LOGLEG,
        span_id: "llm1",
        parent_span_id: "root",
        layer: "llm",
        gen_ai_request_model: "gpt-4o-mini",
        prompt: "",
        completion: "",
        start_time: srchStart,
        duration_ns: NS_PER_SECOND.toString(),
        k8s_namespace: "",
        k8s_pod: "",
      }),
    ],
  });

  await seed.insert({
    table: "logs",
    format: "JSONEachRow",
    values: [
      // D42 content carriers (bodyless): excluded from the rail's DISPLAY, but
      // IN the search reach (D45 — the UI folds this content into LlmDetail).
      logRow({
        trace_id: LOGLEG,
        span_id: "llm1",
        timestamp: srchStart,
        body: "",
        prompt: `event prompt ${tokCarrierP}`,
        k8s_namespace: "",
        k8s_pod: "",
      }),
      logRow({
        trace_id: LOGLEG,
        span_id: "llm1",
        timestamp: srchStart,
        body: "",
        completion: `event completion ${tokCarrierC}`,
        k8s_namespace: "",
        k8s_pod: "",
      }),
      logRow({
        trace_id: LOGLEG,
        timestamp: srchStart,
        body: `worker heartbeat ${tokBody}`,
        k8s_namespace: "",
        k8s_pod: "",
      }),
      // trace-less: the traces list must never reach it (contract: trace-carrying rows only)
      logRow({
        trace_id: "",
        timestamp: srchStart,
        body: `stray ${tokTraceless}`,
        k8s_namespace: "",
        k8s_pod: "",
      }),
    ],
  });

  await t.test("D44: the total is the exact filtered count over the page's own predicate, not the page length", async () => {
    const page1 = await queryTraceSearch({ service: PAGE_SVC });
    assert.equal(
      page1.total,
      pageCount,
      `total must be the filtered count (${pageCount}), not the page length (${page1.traces.length})`,
    );
    assert.equal(page1.traces.length, TRACE_PAGE_SIZE);
    assert.deepEqual(
      page1.traces.map((tr) => tr.id),
      pageIds.slice(0, TRACE_PAGE_SIZE),
      "equal-start traces must order by trace id ascending — the mandatory D44 tie-break",
    );
  });

  await t.test("D44: page 2 is a disjoint, ordered continuation reproducible from its parameters alone", async () => {
    const page2 = await queryTraceSearch({ service: PAGE_SVC, page: 2 });
    assert.deepEqual(
      page2.traces.map((tr) => tr.id),
      pageIds.slice(TRACE_PAGE_SIZE),
      "page 2 must be the continuation after page 1 — an ignored offset repeats page 1",
    );
    assert.equal(page2.total, pageCount, "the total must not depend on which page was asked for");
  });

  await t.test("D44: the page order is start DESCENDING (newest first), not just tie-broken", async () => {
    const ordered = await queryTraceSearch({ service: ORDER_SVC });
    assert.deepEqual(
      ordered.traces.map((tr) => tr.id),
      [...orderIds].reverse(),
      "distinct-start traces must come back newest-first — `ORDER BY min(min_start) DESC`; an ASC sort (or an id-only sort) returns them oldest-first",
    );
  });

  await t.test("PRD §8: each filter narrows with a control row that would pass without it", async () => {
    const ids = async (filter: Parameters<typeof queryTraceSearch>[0]) =>
      (await queryTraceSearch(filter)).traces.map((tr) => tr.id).sort();
    // baseline: everything carrying the probe token inside the 6h window
    assert.deepEqual(await ids({ q: FILT_TOKEN }), ["a", "b", "c", "d", "e", "g"].map(filtId), "baseline: f is time-excluded, everything else present");
    // service — control: g (present in the baseline, gone here)
    assert.deepEqual(await ids({ q: FILT_TOKEN, service: FILT_SVC }), ["a", "b", "c", "d", "e"].map(filtId));
    // status — control: a
    assert.deepEqual(await ids({ q: FILT_TOKEN, status: "error" }), [filtId("b")]);
    // duration — control: a (1s)
    assert.deepEqual(await ids({ q: FILT_TOKEN, minMs: 5000 }), [filtId("c")]);
    // model — control: a (gpt-4o-mini)
    assert.deepEqual(await ids({ q: FILT_TOKEN, model: MODEL_PROBE }), [filtId("e")]);
    // cost floor — control: a (0.01)
    assert.deepEqual(await ids({ q: FILT_TOKEN, minCostUsd: 0.03 }), [filtId("d")]);
    // cost ceiling — controls: a (0.01) and d (0.05)
    assert.deepEqual(await ids({ q: FILT_TOKEN, service: FILT_SVC, maxCostUsd: 0.005 }), ["b", "c", "e"].map(filtId));
  });

  await t.test("D50: the 6h default time bound is real; rangeMs widens it (control: the 7h-old trace)", async () => {
    const withDefault = await queryTraceSearch({ q: FILT_TOKEN });
    assert.ok(
      !withDefault.traces.some((tr) => tr.id === filtId("f")),
      "a 7h-old trace leaked past the 6h default window",
    );
    const widened = await queryTraceSearch({ q: FILT_TOKEN, rangeMs: 8 * HOUR_MS });
    assert.ok(
      widened.traces.some((tr) => tr.id === filtId("f")),
      "rangeMs did not widen the window",
    );
    assert.equal(widened.total, 7);
  });

  // S2.2 L1 STANDING GUARD: one term reachable ONLY through the spans
  // semi-join and one reachable ONLY through the logs semi-join. A later
  // change that quietly drops either leg — or the whole semi-join mechanism —
  // turns this red forever; it can never go hollow because the tokens exist
  // nowhere else (not in summaries, not in the other leg).
  await t.test("standing guard (S2.2 L1): a spans-leg-only term and a logs-leg-only term both resolve", async () => {
    const bySpan = await queryTraceSearch({ q: tokPrompt });
    assert.ok(
      bySpan.traces.some((tr) => tr.id === SPANLEG),
      "a term living only in a span prompt did not resolve — the spans semi-join leg is gone",
    );
    const byLog = await queryTraceSearch({ q: tokBody });
    assert.ok(
      byLog.traces.some((tr) => tr.id === LOGLEG),
      "a term living only in a log body did not resolve — the logs semi-join leg is gone",
    );
  });

  // The D45 reach set opens with the SUMMARY fields, and none of them is
  // reachable through either semi-join: the spans leg searches `name`/`prompt`/
  // `completion` only, so a model name, a service name and a trace id are
  // answerable ONLY by the summary predicates. Each assertion below goes red on
  // deleting exactly one of them. (`root_name` has no independent probe and can
  // have none: it is `argMinIf` of the ROOT SPAN's `name`, so every value it can
  // hold is also a `spans.name` the spans leg already matches — the summary
  // predicate is a fast path over that leg, not separate reach. In mock mode
  // `rootName` IS a separate field, and data.test.ts guards it there.)
  await t.test("D45 summary-field reach: model, service and trace id resolve with no semi-join to help", async () => {
    const byModel = await queryTraceSearch({ q: MODEL_PROBE });
    assert.deepEqual(
      byModel.traces.map((tr) => tr.id),
      [filtId("e")],
      "a model name resolved nowhere — `arrayExists(m -> …, models)` is gone and model search is dead (spans.gen_ai_* is in no leg)",
    );
    const byService = await queryTraceSearch({ q: OTHER_SVC });
    assert.deepEqual(
      byService.traces.map((tr) => tr.id),
      [filtId("g")],
      "a service name resolved nowhere — `arrayExists(s -> …, services)` is gone (spans.service is in no leg)",
    );
    const byTraceId = await queryTraceSearch({ q: filtId("a") });
    assert.deepEqual(
      byTraceId.traces.map((tr) => tr.id),
      [filtId("a")],
      "pasting a trace id into the search box resolved nothing — `positionCaseInsensitiveUTF8(trace_id, …)` is gone",
    );
  });

  // D56 (S2.0 L1): shown RED under the pre-D56 ASCII function — with
  // `positionCaseInsensitive` the É→é fold never happens and this returns
  // nothing; only `positionCaseInsensitiveUTF8` in EVERY freeTextClauses
  // predicate turns it green. Mock's toLowerCase side of the same pair is
  // asserted in the parity table below and in data.test.ts.
  await t.test("D56 Unicode case folding: a query case-differing on a non-ASCII letter still matches (café finds CAFÉ)", async () => {
    const r = await queryTraceSearch({ q: tokCafeQuery });
    assert.deepEqual(
      r.traces.map((tr) => tr.id),
      [SPANLEG],
      "café did not find CAFÉ — a live predicate is folding ASCII (positionCaseInsensitive) instead of Unicode (positionCaseInsensitiveUTF8)",
    );
  });

  await t.test("D42 carrier rows are IN the prompts reach (D45): bodyless carrier content finds its trace", async () => {
    const byCarrierPrompt = await queryTraceSearch({ q: tokCarrierP });
    assert.ok(
      byCarrierPrompt.traces.some((tr) => tr.id === LOGLEG),
      "carrier prompt content did not resolve — the trace is unfindable by its own visible prompt (D13)",
    );
    const byCarrierCompletion = await queryTraceSearch({ q: tokCarrierC });
    assert.ok(
      byCarrierCompletion.traces.some((tr) => tr.id === LOGLEG),
      "carrier completion content did not resolve",
    );
  });

  // The logs leg's `AND trace_id != ''` is LOAD-BEARING, not a by-construction
  // restatement of the semi-join. `trace_summaries` is fed by a materialized
  // view with no write-side trace-id filter, so a span that arrives without a
  // trace id produces a real summary row at `trace_id = ''` — this fixture
  // seeds exactly that (the orphan span above). Without the clause the logs
  // leg hands `''` back for any matching trace-less row, that `''` summary
  // satisfies `trace_id IN (…)`, and the traces list renders a phantom trace
  // with an empty id and a dead detail link. Dropping the clause turns this
  // subtest red; the standing guard above is its live-mechanism partner
  // (the SAME token on a trace-CARRYING row does resolve).
  await t.test("trace-less log rows are unreachable from the traces list, even with an empty-id summary present", async () => {
    const r = await queryTraceSearch({ q: tokTraceless });
    assert.equal(r.total, 0, "a trace-less log row surfaced a trace in the traces list");
    assert.deepEqual(r.traces, []);
    // The falsifier only bites if the empty-id summary really exists: prove it
    // is there and reachable by its own root name, so this probe can never go
    // hollow through the fixture silently disappearing.
    const orphan = await queryTraceSearch({ q: "orphan-no-trace-id" });
    assert.deepEqual(
      orphan.traces.map((tr) => tr.id),
      [""],
      "the empty-trace-id summary fixture is missing — the probe above would then be green by construction",
    );
  });

  // D13: one contract, two implementations. The fixtures mirror the seeded
  // traces in view-model terms (search-contract.md's "mock mapping" section):
  // LOGLEG's carrier content sits on `llm` — exactly where the live read folds
  // it (D42(d)) — and its trace-less neighbour is a traceId-less log entry.
  await t.test("live and mock return the same match verdicts over an equivalent fixture", async () => {
    const span = (over: Partial<Span> & { id: string }): Span => ({
      traceId: SPANLEG,
      parentId: null,
      name: "POST /chat",
      layer: "api" as const,
      service: "demo-agent-it",
      startMs: 0,
      durationMs: 1000,
      status: "ok" as const,
      attrs: {},
      ...over,
    });
    const base = {
      method: "POST",
      service: "demo-agent-it",
      startedAt: new Date(nowMs).toISOString(),
      durationMs: 1000,
      status: "ok" as const,
      spanCount: 2,
      totalTokens: 0,
      costUsd: 0,
      services: ["demo-agent-it"],
      models: ["gpt-4o-mini"],
    };
    const llmDetail = (prompt: string, completion: string) => ({
      model: "gpt-4o-mini",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      prompt,
      completion,
      finishReason: "stop" as const,
    });
    const spanlegFixture = {
      ...base,
      id: SPANLEG,
      rootName: `POST /${rootTok}`,
      spans: [
        span({ id: "root", name: `POST /${rootTok}` }),
        span({
          id: "llm1",
          parentId: "root",
          name: `chat ${tokSpanName}`,
          layer: "llm" as const,
          llm: llmDetail(`user: hello ${tokPrompt} order ${tokCafeSeeded} latte`, `assistant: ${tokCompletion}`),
        }),
      ],
      logs: [],
    };
    const log = (body: string, traceId?: string) => ({
      id: `${LOGLEG}-${body.slice(0, 8)}`,
      traceId,
      atMs: 1,
      severity: "info" as const,
      body,
      namespace: "",
      pod: "",
      container: "app",
    });
    const loglegFixture = {
      ...base,
      id: LOGLEG,
      rootName: "POST /worker",
      spans: [
        span({ id: "root", traceId: LOGLEG, name: "POST /worker" }),
        span({
          id: "llm1",
          traceId: LOGLEG,
          parentId: "root",
          layer: "llm" as const,
          llm: llmDetail(`event prompt ${tokCarrierP}`, `event completion ${tokCarrierC}`),
        }),
      ],
      logs: [log(`worker heartbeat ${tokBody}`, LOGLEG), log(`stray ${tokTraceless}`)],
    };

    const cases: [string, boolean, boolean][] = [
      // NB: rootTok is the ROOT SPAN's name, so live answers it from the spans
      // leg as well as from `root_name` — it does not isolate the summary leg.
      // The summary-only reach fields have their own subtest above.
      [rootTok, true, false],
      [tokSpanName, true, false], // spans leg: name
      [tokPrompt, true, false], // spans leg: prompt column
      [tokCompletion, true, false], // spans leg: completion column
      [tokBody, false, true], // logs leg: body
      [tokCarrierP, false, true], // logs leg: carrier prompt
      [tokCarrierC, false, true], // logs leg: carrier completion
      [tokTraceless, false, false], // trace-less rows out, both modes
      [tokAbsent, false, false],
      [tokSpanName.toUpperCase(), true, false], // case-insensitive
      [tokCafeQuery, true, false], // D56: non-ASCII case pair — both modes fold Unicode
      [`${tokPrompt} ${tokCompletion}`, true, false], // AND across fields, one trace
      [`${tokBody} ${tokCarrierP}`, false, true], // AND across log rows, one trace
      [`${tokSpanName} ${tokBody}`, false, false], // AND never spans two traces
      [`${tokSpanName} ${tokAbsent}`, false, false],
    ];
    for (const [q, expectSpanleg, expectLogleg] of cases) {
      const live = await queryTraceSearch({ q });
      const liveIds = live.traces.map((tr) => tr.id);
      assert.equal(liveIds.includes(SPANLEG), expectSpanleg, `live verdict for ${JSON.stringify(q)} on the span-leg trace`);
      assert.equal(liveIds.includes(LOGLEG), expectLogleg, `live verdict for ${JSON.stringify(q)} on the log-leg trace`);
      assert.equal(mockMatches(spanlegFixture, q), expectSpanleg, `mock verdict for ${JSON.stringify(q)} on the span-leg fixture`);
      assert.equal(mockMatches(loglegFixture, q), expectLogleg, `mock verdict for ${JSON.stringify(q)} on the log-leg fixture`);
    }
  });
});
