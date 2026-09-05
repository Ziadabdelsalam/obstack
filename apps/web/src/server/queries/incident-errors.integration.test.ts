import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";
import { forWorkspace } from "@/server/clickhouse";
// type-only: erased at runtime, so it cannot run ahead of the env setup below
import type { ScopedClickHouse } from "@/server/clickhouse";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait clickhouse
// then:     npm test --workspace apps/web
// (down -v first for a clean volume — see deploy/compose/README.md)
//
// The seeded-ClickHouse half of D531/D534 — the incident timeline's trace leg.
// Every clause the packet calls load-bearing is a clause only a real engine can
// falsify, so each is seeded with the fixture that reds the WRONG implementation
// rather than merely passing under the right one:
//
//   half-open [since, until)  a span AT `since` present, a span AT `until` absent
//   trace_id != ''            an empty-trace error span that would otherwise WIN
//                             the argMin and hand the entry a link to the list
//   argMin, not argMax        two traces four minutes apart under one group
//   ORDER BY first_seen       the cap keeps the EARLIEST rows, not the biggest
//   {workspace_id:String}     another workspace's spans in the same window,
//                             under the same service and span name
//
// Skips only when no ClickHouse answers; `web.yml`'s D36 skip trap fails the job
// on an unexpected skip, so this file executes on every PR.

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const WEB_USER = process.env.CLICKHOUSE_USER ?? "obstack_web";
const WEB_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "obstack_web_dev";
const INGEST_PASSWORD =
  process.env.OBSTACK_TEST_CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";

// `queryIncidentErrors` (imported below) reads these lazily on its first query,
// inside `@/server/clickhouse.ts`'s `getClient()`.
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
 * Two workspaces of this run's own, never the compose dev default `ws_demo`
 * (the `traces.integration.test.ts` precedent) — the reading user has no
 * mutation grant, so nothing seeded here can be cleaned up afterwards.
 *
 * `WORKSPACE_B` is NOT the usual empty control. It is seeded with a span on
 * WORKSPACE_A's own `(service, span name)` group, four minutes EARLIER than
 * A's earliest error: an unscoped read would therefore not merely add a row,
 * it would change A's `errors` count AND A's `example_trace_id`. A scope that
 * broke would be visible in three assertions, not one.
 */
const WORKSPACE_A = `ws_ie_${randomBytes(4).toString("hex")}`;
const WORKSPACE_B = `ws_ieb_${randomBytes(4).toString("hex")}`;

/**
 * The window, half-open `[WINDOW_START_S, WINDOW_END_S)` — thirty minutes,
 * anchored an hour back so every seeded row is well inside the table's 30-day
 * TTL and inside today's or yesterday's `toDate(start_time)` partition.
 *
 * Whole seconds on purpose: `fromUnixTimestamp` has second granularity, so a
 * boundary row can be seeded at EXACTLY the bound and the `>=` / `<` are then
 * the only thing deciding it.
 */
const WINDOW_START_S = Math.floor(Date.now() / 1000) - 3600;
const WINDOW_END_S = WINDOW_START_S + 1800;

const BOUND_SERVICE = "inc-it-bound";
const ARGMIN_SERVICE = "inc-it-argmin";
const ARGMIN_SPAN = "POST /chat";
const EMPTY_SERVICE = "inc-it-empty";

/** The argMin group's three traces. Only ONE of them may be the example. */
const OK_TRACE = `ie${randomBytes(6).toString("hex")}`;
const EARLIER_TRACE = `ie${randomBytes(6).toString("hex")}`;
const LATER_TRACE = `ie${randomBytes(6).toString("hex")}`;
const B_TRACE = `ie${randomBytes(6).toString("hex")}`;
/** The real trace behind an error span whose group ALSO holds a `trace_id = ''` one. */
const DRAIN_TRACE = `ie${randomBytes(6).toString("hex")}`;

/** The argMin group's instants: an `ok` span, then two errors FOUR MINUTES apart. */
const OK_AT_S = WINDOW_START_S + 300;
const EARLIER_AT_S = WINDOW_START_S + 600;
const LATER_AT_S = EARLIER_AT_S + 240;
/** WORKSPACE_B's span on the same group, earlier than every one of A's. */
const B_AT_S = WINDOW_START_S + 60;
/** The empty-trace error span, and the real one that shares its group SIXTY SECONDS LATER. */
const EMPTY_AT_S = WINDOW_START_S + 120;
const DRAIN_AT_S = WINDOW_START_S + 180;

/** `DateTime64(9,'UTC')` wants `'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'` (`traces.integration.test.ts`'s `chTimestamp`). */
function chSecond(epochS: number): string {
  return `${new Date(epochS * 1000).toISOString().slice(0, 19).replace("T", " ")}.000000000`;
}

let nextSpan = 0;

/** A span with the house defaults for everything no probe below cares about. */
function span({
  workspace_id = WORKSPACE_A,
  service,
  name,
  atS,
  trace_id = `ie${randomBytes(6).toString("hex")}`,
  status_code = "error",
}: {
  workspace_id?: string;
  service: string;
  name: string;
  atS: number;
  trace_id?: string;
  status_code?: string;
}) {
  return {
    workspace_id,
    trace_id,
    span_id: `ie${String(nextSpan++).padStart(14, "0")}`,
    parent_span_id: "",
    name,
    kind: "server",
    service,
    layer: "api",
    start_time: chSecond(atS),
    duration_ns: "1000000",
    status_code,
    status_message: "incident-errors integration fixture",
  };
}

test("queryIncidentErrors (D531/D534) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`);
    return;
  }

  const { queryIncidentErrors } = await import("./incident-errors");

  await seed.insert({
    table: "spans",
    format: "JSONEachRow",
    values: [
      // (1) the half-open bound, one row per side of each end. The window is
      //     `[start, end)`: the row AT `start` is inside it, the row AT `end` is
      //     the NEXT incident's (D534 — adjacent windows, and both may not claim
      //     the same instant).
      span({ service: BOUND_SERVICE, name: "at.since", atS: WINDOW_START_S }),
      span({ service: BOUND_SERVICE, name: "one.before.since", atS: WINDOW_START_S - 1 }),
      span({ service: BOUND_SERVICE, name: "one.before.until", atS: WINDOW_END_S - 1 }),
      span({ service: BOUND_SERVICE, name: "at.until", atS: WINDOW_END_S }),
      // (2) the argMin group. Three spans under ONE (service, span name), and
      //     each wrong implementation picks a different trace: `argMax` picks
      //     LATER_TRACE, a missing error filter picks OK_TRACE (it is earliest
      //     of A's three), a broken scope picks WORKSPACE_B's B_TRACE.
      span({ service: ARGMIN_SERVICE, name: ARGMIN_SPAN, atS: OK_AT_S, trace_id: OK_TRACE, status_code: "ok" }),
      span({ service: ARGMIN_SERVICE, name: ARGMIN_SPAN, atS: EARLIER_AT_S, trace_id: EARLIER_TRACE }),
      span({ service: ARGMIN_SERVICE, name: ARGMIN_SPAN, atS: LATER_AT_S, trace_id: LATER_TRACE }),
      // (3) `trace_id != ''`, seeded so that dropping the clause is VISIBLE in
      //     the answer rather than only in the row count: the empty-trace span
      //     is the EARLIER of the two in its group, so without the clause it
      //     wins the argMin and the entry's example trace is `''`.
      //
      //     This row can ONLY be seeded the way it is seeded — direct insert on
      //     the `obstack_ingest` grant. The OTLP path refuses it outright
      //     (`mapping/spans.go:44-46` drops the span with reason=mapping), which
      //     is D570: the clause guards writers that reach the table AROUND the
      //     mapper, not spans that arrive through it. Do not "simplify" this
      //     fixture by routing it through the ingest API — it becomes
      //     unseedable, and the probe below goes green by construction.
      span({ service: EMPTY_SERVICE, name: "drain", atS: EMPTY_AT_S, trace_id: "" }),
      span({ service: EMPTY_SERVICE, name: "drain", atS: DRAIN_AT_S, trace_id: DRAIN_TRACE }),
      //     …and a group with NOTHING but an empty-trace error span, which must
      //     disappear entirely rather than render an unlinkable row.
      span({ service: EMPTY_SERVICE, name: "orphan", atS: WINDOW_START_S + 240, trace_id: "" }),
      // (4) the other workspace, in the same window: one span on A's own group
      //     (earlier than all of A's) and one group of its own.
      span({
        workspace_id: WORKSPACE_B,
        service: ARGMIN_SERVICE,
        name: ARGMIN_SPAN,
        atS: B_AT_S,
        trace_id: B_TRACE,
      }),
      span({ workspace_id: WORKSPACE_B, service: "inc-it-b", name: "b.only.error", atS: WINDOW_START_S + 90 }),
    ],
  });

  const rows = await queryIncidentErrors(forWorkspace(WORKSPACE_A), {
    sinceMs: (WINDOW_START_S) * 1000,
    untilMs: (WINDOW_END_S) * 1000,
    fetch: 50,
  });
  const group = (service: string, spanName: string) =>
    rows.filter((r) => r.service === service && r.span_name === spanName);

  await t.test("the window is HALF-OPEN: the row AT `since` is in, the row AT `until` is out", () => {
    assert.equal(group(BOUND_SERVICE, "at.since").length, 1, "a span at exactly `since` must be INSIDE [since, until)");
    assert.equal(
      group(BOUND_SERVICE, "at.since")[0].first_seen_epoch_s,
      WINDOW_START_S,
      "the included boundary row must be the one seeded at exactly `since`",
    );
    assert.equal(
      group(BOUND_SERVICE, "at.until").length,
      0,
      "a span at exactly `until` belongs to the NEXT window — a closed upper bound lets two adjacent incidents both claim it (D534)",
    );
    // Both bounds are bounds, and both are tested one second from the edge, so
    // "nothing came back from the end of the window" cannot pass for the
    // exclusion above.
    assert.equal(group(BOUND_SERVICE, "one.before.until").length, 1, "the last second of the window is inside it");
    assert.equal(group(BOUND_SERVICE, "one.before.since").length, 0, "one second before `since` is outside the window");
  });

  await t.test("`trace_id != ''` removes the row that would have carried an empty example", () => {
    const drain = group(EMPTY_SERVICE, "drain");
    assert.equal(drain.length, 1);
    // All three of these red without the clause: the empty-trace span is the
    // earlier of the two, so it would be counted, it would set `first_seen`,
    // and `argMin` would return its `''` — and `/app/traces/` + an empty id is
    // the traces LIST, so the entry would link at every trace in the workspace.
    assert.equal(drain[0].errors, 1, "the `trace_id = ''` error span must not be counted");
    assert.equal(drain[0].first_seen_epoch_s, DRAIN_AT_S, "the excluded span must not set the row's instant");
    assert.equal(drain[0].example_trace_id, DRAIN_TRACE);
    assert.notEqual(drain[0].example_trace_id, "", "an empty example trace links at the traces LIST, not at a trace");

    assert.equal(
      group(EMPTY_SERVICE, "orphan").length,
      0,
      "a group whose only error span has no trace id must vanish, not render an unlinkable row",
    );
  });

  await t.test("`example_trace_id` is the EARLIER of the two traces — argMin, and an argMax reds here", () => {
    const chat = group(ARGMIN_SERVICE, ARGMIN_SPAN);
    assert.equal(chat.length, 1);
    assert.equal(chat[0].example_trace_id, EARLIER_TRACE, "the example must be the trace the row is DRAWN at (D532)");
    assert.notEqual(chat[0].example_trace_id, LATER_TRACE, "argMax would link the trace four minutes AFTER the row's instant");
    assert.notEqual(chat[0].example_trace_id, OK_TRACE, "the `ok` span is not an error and cannot be the example");
    assert.notEqual(chat[0].example_trace_id, B_TRACE, "another workspace's trace must never be this row's example");
    // The row states its own grain (D532): drawn at `first_seen`, extending to
    // `last_seen`, four minutes apart — the count belongs to the span, not to
    // the instant.
    assert.equal(chat[0].first_seen_epoch_s, EARLIER_AT_S);
    assert.equal(chat[0].last_seen_epoch_s, LATER_AT_S);
    assert.equal(chat[0].last_seen_epoch_s - chat[0].first_seen_epoch_s, 240);
    assert.equal(chat[0].errors, 2, "the `ok` span and the other workspace's span must both be out of the count");
  });

  await t.test("the workspace scope holds: another workspace's spans in the same window are absent", () => {
    assert.deepEqual(
      rows.map((r) => `${r.service}/${r.span_name}`).sort(),
      [
        `${ARGMIN_SERVICE}/${ARGMIN_SPAN}`,
        `${BOUND_SERVICE}/at.since`,
        `${BOUND_SERVICE}/one.before.until`,
        `${EMPTY_SERVICE}/drain`,
      ],
      "exactly the four in-window, non-empty-trace groups of THIS workspace",
    );
    assert.equal(
      rows.filter((r) => r.service === "inc-it-b").length,
      0,
      "WORKSPACE_B's own group must not appear in WORKSPACE_A's read",
    );
  });

  await t.test("WORKSPACE_B sees its own two groups and none of WORKSPACE_A's", async () => {
    const bRows = await queryIncidentErrors(forWorkspace(WORKSPACE_B), {
      sinceMs: (WINDOW_START_S) * 1000,
      untilMs: (WINDOW_END_S) * 1000,
      fetch: 50,
    });
    assert.deepEqual(
      bRows.map((r) => `${r.service}/${r.span_name}`).sort(),
      [`inc-it-b/b.only.error`, `${ARGMIN_SERVICE}/${ARGMIN_SPAN}`].sort(),
    );
    const bChat = bRows.filter((r) => r.span_name === ARGMIN_SPAN)[0];
    assert.equal(bChat.errors, 1, "B's group holds B's one span, not A's two");
    assert.equal(bChat.example_trace_id, B_TRACE);
    assert.equal(bRows.filter((r) => r.service === BOUND_SERVICE).length, 0);
  });

  await t.test("the cap keeps the EARLIEST rows, undropped — `ORDER BY first_seen`, not by count", () => {
    // The four groups in chronological order are at.since (+0s), drain (+180s),
    // POST /chat (+600s), one.before.until (+1799s). `POST /chat` is the only
    // group with TWO errors, so a `count DESC` order would put it first and this
    // assertion reds.
    assert.deepEqual(
      rows.map((r) => `${r.service}/${r.span_name}`),
      [
        `${BOUND_SERVICE}/at.since`,
        `${EMPTY_SERVICE}/drain`,
        `${ARGMIN_SERVICE}/${ARGMIN_SPAN}`,
        `${BOUND_SERVICE}/one.before.until`,
      ],
      "rows come back chronologically — a cap on a ranked list would delete the quiet tail (D531)",
    );
  });

  await t.test("every row the LIMIT returns is handed back UNDROPPED — the probe row is the caller's (D536)", async () => {
    const capped = await queryIncidentErrors(forWorkspace(WORKSPACE_A), {
      sinceMs: (WINDOW_START_S) * 1000,
      untilMs: (WINDOW_END_S) * 1000,
      fetch: 2,
    });
    assert.equal(capped.length, 2, "`fetch` rows come back, not `fetch - 1`: this module never eats the probe row");
    assert.deepEqual(
      capped.map((r) => `${r.service}/${r.span_name}`),
      [`${BOUND_SERVICE}/at.since`, `${EMPTY_SERVICE}/drain`],
      "the LIMIT keeps the earliest rows, and the caller's `rows.length > cap` is what detects truncation",
    );
    // D536's "the probe row gives `omittedAfterIso` for free": with cap = 1 and
    // fetch = 2, the last row the cap KEPT is `capped[0]` and its instant is the
    // one the surface states — read off this same array, with no second read.
    assert.equal(capped[0].first_seen_epoch_s, WINDOW_START_S);
  });
});

/**
 * `runScoped`'s two refusals (D549 Path F), proven on THIS module's own
 * statement rather than on a statement written for the test.
 *
 * The statement is lifted with a recording `ScopedClickHouse` — the interface is
 * one method, so `queryIncidentErrors` hands its real SQL and its real params to
 * anything shaped like a client — and then fed back through the REAL
 * `forWorkspace` client. What is proven is therefore that the shipped bytes
 * carry the placeholder and that the shipped bytes are refused once it is gone,
 * not that some SQL somewhere would be.
 */
test("queryIncidentErrors: the statement carries `{workspace_id:` and runScoped refuses it without one", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`);
    return;
  }

  const { queryIncidentErrors } = await import("./incident-errors");

  const calls: { sql: string; params: Record<string, unknown> }[] = [];
  const recorder: ScopedClickHouse = {
    async queryRows<Row>(sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
      calls.push({ sql, params });
      return [];
    },
  };
  await queryIncidentErrors(recorder, { sinceMs: (WINDOW_START_S) * 1000, untilMs: (WINDOW_END_S) * 1000, fetch: 51 });
  assert.equal(calls.length, 1, "the trace leg is ONE read");
  const { sql, params } = calls[0];

  await t.test("the shipped statement carries the placeholder, and binds no workspace_id itself", () => {
    assert.ok(
      sql.includes("{workspace_id:String}"),
      "`runScoped` is a TEXT check on the SQL — without this literal the statement never reaches the server",
    );
    assert.equal(
      Object.hasOwn(params, "workspace_id"),
      false,
      "the scope is `forWorkspace`'s to bind (D113); a caller-supplied one is refused below",
    );
    assert.deepEqual(params, { since_ms: WINDOW_START_S * 1000, until_ms: WINDOW_END_S * 1000, fetch: 51 });
  });

  await t.test("a caller-supplied workspace_id that is not this scope's is refused", async () => {
    await assert.rejects(
      () => forWorkspace(WORKSPACE_A).queryRows(sql, { ...params, workspace_id: WORKSPACE_B }),
      /refusing a caller-supplied workspace_id/,
    );
  });

  await t.test("the same statement with its tenancy predicate removed is refused — and it WOULD have leaked", async () => {
    const leaky = sql.replace("workspace_id = {workspace_id:String} AND ", "");
    assert.notEqual(leaky, sql, "the predicate fragment must actually have been removed for this proof to mean anything");
    assert.equal(leaky.includes("{workspace_id:"), false);

    // First: the mutilated statement is VALID SQL that really does read across
    // tenants — otherwise "it was refused" would prove nothing but a syntax
    // error. Run through the seeding client, which has no tripwire.
    // `fetch` is deliberately huge here: with the tenancy predicate gone this
    // reads EVERY workspace's error groups in the window (measured: 12 groups
    // across 22 workspaces already sit in the compose store's last hour), and a
    // cap tight enough for one workspace could push the two rows this asserts on
    // past the LIMIT as the store grows.
    const leaked = await (
      await seed.query({
        query: leaky,
        query_params: { ...params, fetch: 100_000 },
        format: "JSONEachRow",
      })
    ).json<{ service: string; span_name: string }>();
    const leakedNames = leaked.map((r) => `${r.service}/${r.span_name}`);
    assert.ok(leakedNames.includes("inc-it-b/b.only.error"), "the unscoped statement reads WORKSPACE_B's rows");
    assert.ok(leakedNames.includes(`${BOUND_SERVICE}/at.since`), "…and WORKSPACE_A's, in one answer");

    // Then: `runScoped` kills it before it reaches the server.
    await assert.rejects(() => forWorkspace(WORKSPACE_A).queryRows(leaky, params), /refusing unscoped SQL/);
  });
});
