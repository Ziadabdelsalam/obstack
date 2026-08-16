import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";
import { NEARBY_LOG_CAP } from "@/lib/nearby-logs";

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
// integration_test.go — but note that only half of that precedent exists here:
// the `go` check starts the compose ClickHouse and then FAILS the job on any
// "--- SKIP" line (.github/workflows/go.yml, "D36 skip trap"), so those tests
// cannot go quietly green. `web` starts no ClickHouse and greps no output, so
// today this file runs only where a human or the sprint's `stack` job supplies
// one. Closing that (ClickHouse service + skip trap in web.yml) is a CI change
// outside T3's ownership — escalated, not absorbed here.
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
