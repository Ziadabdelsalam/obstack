import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";
import type { AlertDelivery, AlertSeverity } from "@/lib/alert-types";
import type { ChangeKind } from "@/lib/change-types";
import type { IncidentTimelineEntry } from "@/lib/incident-types";
import type { ScopedClickHouse } from "./clickhouse";
import {
  CHANGE_LEAD_IN_CAP,
  CHANGE_LEAD_IN_MS,
  TIMELINE_LEG_CAP,
  TIMELINE_SOURCE_RANK,
  readIncidentTimeline,
  sortTimelineEntries,
} from "./incident-timeline";
import type { QueryRows } from "./postgres";
import type { IncidentErrorRow } from "./queries/incident-errors";

// run with: cd apps/web && npx tsx --conditions react-server --test src/server/incident-timeline.test.ts
//
// The stitcher's contract with NO Postgres and NO ClickHouse (the `alerts.test.ts`
// / `incidents.test.ts` hermetic idiom, extended across two stores): what the
// three legs are ASKED for, what the merge does with what comes back, and which
// of D540's three render states the answer is in.
//
// This file cannot prove a boundary INSIDE a store — a fake returns the rows it
// was handed whatever the predicate says. It proves the half of D534 that is the
// stitcher's: the bounds it binds, the statement text it binds them into, and
// that a window and its adjacent successor cannot both claim the shared instant.
// The other half — an event stamped exactly at `end` excluded, one at `start`
// included — is `alerts.integration.test.ts`, `changes.integration.test.ts` and
// `queries/incident-errors.integration.test.ts`, against real engines.

// ---- the recording harness ---------------------------------------------------

type Statement = { sql: string; params: unknown[] };

type AlertDbRow = {
  id: string;
  rule_id: string | null;
  rule_name: string | null;
  slo_id: string | null;
  slo_name: string | null;
  severity: AlertSeverity;
  title: string;
  detail: string;
  link: string | null;
  delivery: AlertDelivery;
  created_at: Date;
};

type ChangeDbRow = {
  id: string;
  kind: ChangeKind;
  at: Date;
  title: string;
  detail: string;
  who: string;
  service: string | null;
  ref: string | null;
  source: string | null;
  link_label: string | null;
  link_href: string | null;
};

type Fixture = {
  alerts?: AlertDbRow[];
  /** The IN-WINDOW changes read's rows (`ORDER BY at, id`). */
  changes?: ChangeDbRow[];
  /** The LEAD-IN read's rows, in the SQL's own DESC order (D535). */
  leadIn?: ChangeDbRow[];
  errors?: IncidentErrorRow[];
};

/**
 * Both stores, recording. The Postgres fake dispatches on the statement's own
 * text rather than on call order, so a stitcher that issues its reads in a
 * different order — or fuses the two changes reads into one — still gets the
 * rows the fixture names for that shape, and the assertion that fails is the
 * one about the defect rather than an incidental row-count mismatch.
 */
function harness(fixture: Fixture = {}) {
  const seen: Statement[] = [];
  const query: QueryRows = async <Row extends QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> => {
    seen.push({ sql, params });
    if (/FROM alert_events/.test(sql)) return (fixture.alerts ?? []) as unknown as Row[];
    if (/FROM change_events/.test(sql)) {
      return (/ORDER BY at DESC/.test(sql) ? (fixture.leadIn ?? []) : (fixture.changes ?? [])) as unknown as Row[];
    }
    throw new Error(`the stitcher issued a statement this harness does not know: ${sql}`);
  };

  const chSeen: { sql: string; params: Record<string, unknown> }[] = [];
  const ch: ScopedClickHouse = {
    async queryRows<Row>(sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
      chSeen.push({ sql, params });
      return (fixture.errors ?? []) as Row[];
    },
  };

  return { query: query as never, seen, ch, chSeen };
}

const alertsRead = (seen: Statement[]) => seen.find((s) => /FROM alert_events/.test(s.sql));
const windowRead = (seen: Statement[]) =>
  seen.find((s) => /FROM change_events/.test(s.sql) && !/ORDER BY at DESC/.test(s.sql));
const leadInRead = (seen: Statement[]) =>
  seen.find((s) => /FROM change_events/.test(s.sql) && /ORDER BY at DESC/.test(s.sql));

// ---- fixtures ----------------------------------------------------------------

const WS = "ws_incident_timeline";
/** Never returned by any fake — the id a broken scope would have to reach for. */
const OTHER_WS = "ws_someone_else";

const PLAN = "Free";
const RETENTION_DAYS = 7;

const WINDOW_START = "2026-09-04T13:00:00.000Z";
const WINDOW_END = "2026-09-04T13:30:00.000Z";
const LEAD_IN_START = "2026-09-04T12:00:00.000Z";
const startedMs = Date.parse(WINDOW_START);
const endedMs = Date.parse(WINDOW_END);

/** A clock far enough after the window that nothing is clipped at 7 days. */
const NOW_INSIDE_RETENTION = Date.parse("2026-09-05T09:00:00.000Z");

const RESOLVED = { startedAt: WINDOW_START, endedAt: WINDOW_END };
const ONGOING = { startedAt: WINDOW_START, endedAt: null };

const iso = (ms: number) => new Date(ms).toISOString();
const epochS = (isoString: string) => Math.floor(Date.parse(isoString) / 1000);
const epochMs = (isoString: string) => Date.parse(isoString);

function alertRow(over: Partial<AlertDbRow> = {}): AlertDbRow {
  return {
    id: "evt_aaaa0000",
    rule_id: "rul_1",
    rule_name: "p95 over 2s",
    slo_id: null,
    slo_name: null,
    severity: "critical",
    title: "Error rate 14.2% on POST /chat",
    detail: "webhook notified",
    link: "/app/traces?status=error",
    delivery: "delivered",
    created_at: new Date("2026-09-04T13:05:00.000Z"),
    ...over,
  };
}

function changeRow(over: Partial<ChangeDbRow> = {}): ChangeDbRow {
  return {
    id: "chg_bbbb0000",
    kind: "deploy",
    at: new Date("2026-09-04T13:10:00.000Z"),
    title: "deploy checkout 9f2c1a",
    detail: "3 commits",
    who: "ci",
    service: "checkout",
    ref: "9f2c1a",
    source: "github-actions",
    link_label: "workflow run",
    link_href: "https://example.test/runs/42",
    ...over,
  };
}

function errorRow(over: Partial<IncidentErrorRow> = {}): IncidentErrorRow {
  return {
    service: "agent-worker",
    span_name: "POST /chat",
    errors: 2,
    first_seen_epoch_s: epochS("2026-09-04T13:04:00.000Z"),
    last_seen_epoch_s: epochS("2026-09-04T13:19:00.000Z"),
    example_trace_id: "c9d4e71f3a2b8c56",
    ...over,
  };
}

/** `n` alert rows one minute apart from 13:01, oldest first — the leg's own order. */
const alertRuns = (n: number): AlertDbRow[] =>
  Array.from({ length: n }, (_, i) =>
    alertRow({ id: `evt_${String(i).padStart(8, "0")}`, created_at: new Date(startedMs + (i + 1) * 60_000) }),
  );

/** `n` change rows one minute apart from 13:01, oldest first. */
const changeRuns = (n: number): ChangeDbRow[] =>
  Array.from({ length: n }, (_, i) =>
    changeRow({ id: `chg_${String(i).padStart(8, "0")}`, at: new Date(startedMs + (i + 1) * 60_000) }),
  );

/** `n` lead-in change rows, NEWEST first — the order `LIST_EVENTS_IN_LEAD_IN_SQL` returns. */
const leadInRuns = (n: number): ChangeDbRow[] =>
  Array.from({ length: n }, (_, i) =>
    changeRow({ id: `chg_lead_${String(i).padStart(8, "0")}`, at: new Date(startedMs - (i + 1) * 30_000) }),
  );

/** `n` error groups one minute apart from 13:02. */
const errorRuns = (n: number): IncidentErrorRow[] =>
  Array.from({ length: n }, (_, i) =>
    errorRow({
      span_name: `GET /p${String(i).padStart(3, "0")}`,
      first_seen_epoch_s: epochS(WINDOW_START) + (i + 2) * 60,
      last_seen_epoch_s: epochS(WINDOW_START) + (i + 2) * 60 + 30,
    }),
  );

/** The one clock, stubbed to a counter so a second sample is COUNTABLE (D534). */
async function withClock<T>(first: number, work: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const real = Date.now;
  let calls = 0;
  Date.now = () => {
    calls += 1;
    // Every sample after the first is a DIFFERENT instant: a stitcher that reads
    // the clock per leg then binds three bounds that differ by a millisecond,
    // which is exactly the "three clocks on two machines" defect, made visible
    // without needing two machines.
    return first + (calls - 1) * 1_000;
  };
  try {
    return { result: await work(), calls };
  } finally {
    Date.now = real;
  }
}

const kinds = (entries: IncidentTimelineEntry[]) => entries.map((e) => e.kind);
const keys = (entries: IncidentTimelineEntry[]) => entries.map((e) => e.key);

// ---- (1) every leg binds the workspace it was handed, and no other ------------

test("all three legs bind the workspace they were handed, and the CH leg binds none of its own (D530/D113)", async () => {
  const { query, seen, ch, chSeen } = harness({
    alerts: [alertRow()],
    changes: [changeRow()],
    leadIn: leadInRuns(2),
    errors: [errorRow()],
  });

  await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );

  assert.equal(seen.length, 3, "the Postgres side is exactly three reads: alerts, in-window changes, lead-in changes");
  for (const { sql, params } of seen) {
    assert.match(sql, /WHERE (e\.)?workspace_id = \$1/, `a leg does not scope by workspace: ${sql}`);
    assert.equal(params[0], WS, `a leg bound the wrong workspace: ${sql}`);
    assert.ok(
      !params.some((p) => p === OTHER_WS),
      `a leg carried another workspace's id in its parameters: ${JSON.stringify(params)}`,
    );
  }

  // These three are the ClickHouse half of the same rule — and two of them are
  // pins on `queries/incident-errors.ts` OBSERVED through the stitcher, not
  // properties of the stitcher itself. Stated because it was MEASURED: defanging
  // this module to pass `workspace_id: workspaceId` into `queryIncidentErrors`'
  // argument object left the run green, because that module builds its own
  // `query_params` from `sinceMs`/`untilMs`/`fetch` and nothing else. The scope
  // therefore cannot be leaked from here, and the falsifiable half of this test
  // is the Postgres loop above (proven red by binding one leg to another
  // workspace) plus the call count.
  assert.equal(chSeen.length, 1, "the trace leg is ONE ClickHouse read");
  assert.ok(
    chSeen[0].sql.includes("{workspace_id:"),
    "the trace leg's SQL must literally carry the placeholder `runScoped`'s tripwire looks for (D531)",
  );
  assert.equal(
    chSeen[0].params.workspace_id,
    undefined,
    "the scope binds workspace_id; a caller-supplied one is refused by runScoped, so the stitcher must never send one (D113)",
  );
});

// ---- (2) half-open at BOTH edges ---------------------------------------------

test("the bounds are half-open [start, end) on all three legs, and the statements say so (D534)", async () => {
  const { query, seen, ch, chSeen } = harness({ leadIn: leadInRuns(1) });

  await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );

  assert.deepEqual(alertsRead(seen)?.params, [WS, WINDOW_START, WINDOW_END, TIMELINE_LEG_CAP + 1]);
  assert.deepEqual(windowRead(seen)?.params, [WS, WINDOW_START, WINDOW_END, TIMELINE_LEG_CAP + 1]);
  assert.deepEqual(leadInRead(seen)?.params, [WS, LEAD_IN_START, WINDOW_START, CHANGE_LEAD_IN_CAP + 1]);

  for (const { sql } of seen) {
    assert.doesNotMatch(sql, /BETWEEN/, `a leg used a CLOSED bound: ${sql}`);
    assert.doesNotMatch(sql, /<= \$3/, `a leg used a closed upper bound: ${sql}`);
    assert.match(sql, />= \$2/, `a leg's lower bound is not inclusive: ${sql}`);
    assert.match(sql, /< \$3/, `a leg's upper bound is not exclusive: ${sql}`);
  }

  assert.equal(chSeen[0].params.since_ms, epochMs(WINDOW_START));
  assert.equal(chSeen[0].params.until_ms, epochMs(WINDOW_END));
  assert.equal(chSeen[0].params.fetch, TIMELINE_LEG_CAP + 1);
  assert.match(chSeen[0].sql, /start_time >= fromUnixTimestamp64Milli\(\{since_ms:Int64\}\)/);
  assert.match(chSeen[0].sql, /start_time <\s+fromUnixTimestamp64Milli\(\{until_ms:Int64\}\)/);
  assert.doesNotMatch(chSeen[0].sql, /start_time <=/, "a closed upper bound lets the next incident claim this one's last instant");
});

test("two ADJACENT incidents cannot both claim the instant they share (D534)", async () => {
  const shared = WINDOW_END;
  const first = harness();
  const second = harness();

  const a = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, { startedAt: WINDOW_START, endedAt: shared }, RETENTION_DAYS, PLAN, first.ch, first.query),
  );
  await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(
      WS,
      { startedAt: shared, endedAt: "2026-09-04T14:00:00.000Z" },
      RETENTION_DAYS,
      PLAN,
      second.ch,
      second.query,
    ),
  );

  assert.equal(alertsRead(first.seen)?.params[2], shared, "the earlier incident's upper bound is the shared instant");
  assert.equal(alertsRead(second.seen)?.params[1], shared, "the later incident's lower bound is the same instant");
  // `< upper` on the first and `>= lower` on the second is a partition: the row
  // AT the shared instant belongs to exactly one of them, and it is the second.
  assert.equal(a.result.windowEndIso, shared);
  assert.equal(
    a.result.entries.at(-1)?.kind,
    "resolved",
    "the synthesized resolved row sits AT the exclusive bound — it is the one thing there, and it was not read",
  );
});

// ---- (3) ONE clock, sampled once ---------------------------------------------

test("the clock is sampled ONCE and all three legs get byte-equal upper bounds (D534)", async () => {
  const { query, seen, ch, chSeen } = harness({ leadIn: leadInRuns(1) });

  const { result, calls } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, ONGOING, RETENTION_DAYS, PLAN, ch, query),
  );

  assert.equal(calls, 1, "the clock advanced more than once: three legs across two stores are then three clocks");

  const expected = iso(NOW_INSIDE_RETENTION);
  assert.equal(result.windowEndIso, expected, "an ongoing incident's window end IS the sampled clock");
  assert.equal(alertsRead(seen)?.params[2], expected);
  assert.equal(windowRead(seen)?.params[2], expected);
  assert.equal(
    alertsRead(seen)?.params[2],
    windowRead(seen)?.params[2],
    "the two Postgres legs' upper bounds must be byte-equal, not merely close",
  );
  // D572: the trace leg's upper bound is now the SAME millisecond the two
  // Postgres legs got — byte-equal, not a floored second of it.
  assert.equal(chSeen[0].params.until_ms, NOW_INSIDE_RETENTION);
});

test("a RESOLVED incident samples the clock once too — the retention floor needs it (D540)", async () => {
  const { query, ch } = harness();
  const { calls } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );
  assert.equal(calls, 1);
});

// ---- (4) the total order is a STATED rule, not a concat artefact --------------

test("the (at, sourceRank, key) order is identical under a DIFFERENT concat order (D538)", async () => {
  const at = "2026-09-04T13:05:00.000Z";
  const entry = (kind: IncidentTimelineEntry["kind"], key: string): IncidentTimelineEntry => ({
    kind,
    at,
    until: null,
    title: key,
    detail: "",
    link: null,
    key,
  });

  // Four kinds at ONE instant, plus two of one kind so the key tie-break is
  // exercised as well. Note what is NOT claimed here: `Array.prototype.sort` has
  // been stable since ES2019, so this is not a flakiness probe — it is the proof
  // that the tie order is a RULE, by feeding the same set in two orders that a
  // stability-only implementation would render differently.
  const set = [
    entry("resolved", "resolved"),
    entry("trace", "trace:agent-worker:POST%20%2Fchat"),
    entry("alert", "evt_2"),
    entry("alert", "evt_1"),
    entry("change", "chg_9"),
  ];
  const wanted = ["chg_9", "evt_1", "evt_2", "trace:agent-worker:POST%20%2Fchat", "resolved"];

  assert.deepEqual(keys(sortTimelineEntries(set)), wanted, "the stated order is change, alert, trace, resolved, then key");
  assert.deepEqual(
    keys(sortTimelineEntries([...set].reverse())),
    wanted,
    "a different concat order rendered a different sequence — the tie order is an artefact, not a rule",
  );
  assert.deepEqual(keys(sortTimelineEntries([set[3], set[0], set[4], set[1], set[2]])), wanted);

  assert.deepEqual(TIMELINE_SOURCE_RANK, { change: 0, alert: 1, trace: 2, resolved: 3 });
});

test("the stitched answer is in that same order, instants first (D538)", async () => {
  const { query, ch } = harness({
    alerts: [alertRow({ id: "evt_1", created_at: new Date("2026-09-04T13:10:00.000Z") })],
    changes: [changeRow({ id: "chg_1", at: new Date("2026-09-04T13:10:00.000Z") })],
    errors: [
      errorRow({
        first_seen_epoch_s: epochS("2026-09-04T13:10:00.000Z"),
        last_seen_epoch_s: epochS("2026-09-04T13:12:00.000Z"),
      }),
    ],
    leadIn: leadInRuns(1),
  });

  const timeline = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );

  assert.deepEqual(kinds(timeline.result.entries), ["change", "change", "alert", "trace", "resolved"]);
  assert.deepEqual(
    timeline.result.entries,
    sortTimelineEntries(timeline.result.entries),
    "the merge must already be in the total order",
  );
  const ats = timeline.result.entries.map((e) => e.at);
  assert.deepEqual([...ats].sort(), ats, "every leg must emit a fixed-width toISOString so the string IS the instant order");
});

// ---- (5) outsideRetention: ZERO reads ----------------------------------------

test("a window entirely below the retention floor issues ZERO reads and claims no deletion (D540)", async () => {
  const { query, seen, ch, chSeen } = harness({
    alerts: alertRuns(3),
    changes: changeRuns(3),
    leadIn: leadInRuns(3),
    errors: errorRuns(3),
  });

  // The clock is 30 days on; the plan retains 7.
  const now = endedMs + 30 * 86_400_000;
  const { result } = await withClock(now, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );

  assert.equal(result.outsideRetention, true);
  assert.equal(seen.length, 0, "a window older than the floor must issue no Postgres statement at all");
  assert.equal(chSeen.length, 0, "…and the ClickHouse fake must never be called");
  assert.deepEqual(kinds(result.entries), ["resolved"], "only the row synthesized from the incident's OWN ended_at survives");
  assert.equal(result.entries[0].at, WINDOW_END);
  assert.deepEqual(result.omissions, [], "nothing was read, so nothing was truncated");
  assert.equal(result.retentionDays, RETENTION_DAYS);
  assert.equal(result.planName, PLAN);
});

// ---- (6) the clip note SURVIVES rows ------------------------------------------

test("the clipped state survives a NON-EMPTY result — the assertion that matters (D540)", async () => {
  const { query, seen, ch, chSeen } = harness({
    alerts: alertRuns(2),
    changes: changeRuns(2),
    leadIn: leadInRuns(2),
    errors: errorRuns(2),
  });

  // The incident started 10 days ago and ran into the retained window; the plan
  // retains 7 days, so the READ starts at the floor, not at `started_at`.
  const now = Date.parse("2026-09-14T13:00:00.000Z");
  const startedAt = "2026-09-04T13:00:00.000Z";
  const endedAt = "2026-09-14T12:00:00.000Z";
  const floorIso = iso(now - RETENTION_DAYS * 86_400_000);

  const { result } = await withClock(now, () =>
    readIncidentTimeline(WS, { startedAt, endedAt }, RETENTION_DAYS, PLAN, ch, query),
  );

  assert.ok(result.entries.length > 0, "the fixture must return rows — an empty result would prove nothing here");
  assert.equal(result.outsideRetention, false, "part of the window IS retained, so this is the clipped state, not the zero-read one");
  assert.equal(result.windowStartIso, floorIso, "the clipped state must survive a non-empty result");
  assert.notEqual(result.windowStartIso, startedAt);
  assert.equal(result.retentionDays, RETENTION_DAYS);
  assert.equal(result.planName, PLAN);

  // Clip the INPUT, not the output (D540): the SQL is never ASKED for rows that
  // were deleted, so an empty leg can only mean nothing happened.
  assert.equal(alertsRead(seen)?.params[1], floorIso);
  assert.equal(windowRead(seen)?.params[1], floorIso);
  assert.equal(chSeen[0].params.since_ms, Date.parse(floorIso));

  // The lead-in hour is entirely below the floor, so its read is not issued at
  // all — a second statement asking for swept rows would be the same defect.
  assert.equal(leadInRead(seen), undefined);
  assert.equal(seen.length, 2);

  // The register is DATA here (`retentionDays`/`planName`), never a sentence
  // this module authored: no date is named and no deletion is asserted.
  const words = JSON.stringify(result);
  for (const banned of ["retained on", "deleted", "swept", "no longer available"]) {
    assert.ok(!words.includes(banned), `the stitcher authored a retention claim: ${banned}`);
  }
});

test("an unclipped window reports its own start, and issues the lead-in read (D540)", async () => {
  const { query, seen, ch } = harness({ leadIn: leadInRuns(1) });
  const { result } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );
  assert.equal(result.windowStartIso, WINDOW_START, "nothing was clipped, so the read starts at the incident's own start");
  assert.equal(result.outsideRetention, false);
  assert.equal(seen.length, 3);
});

// ---- (7) the lead-in cannot eat the in-window cap -----------------------------

test("60 changes in the lead-in hour cannot eat the in-window cap (D535)", async () => {
  const inWindow = changeRuns(3);
  const { query, seen, ch } = harness({ leadIn: leadInRuns(60), changes: inWindow });

  const { result } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );

  const changeKeys = result.entries.filter((e) => e.kind === "change").map((e) => e.key);
  for (const row of inWindow) {
    assert.ok(changeKeys.includes(row.id), `an in-window change was pushed out by the lead-in: ${row.id}`);
  }
  assert.equal(
    changeKeys.length,
    CHANGE_LEAD_IN_CAP + inWindow.length,
    "two reads, two caps: the band keeps its own CHANGE_LEAD_IN_CAP and the window keeps all of its own",
  );

  // Two separate statements is the mechanism, so it is asserted directly.
  assert.equal(seen.length, 3);
  assert.equal(leadInRead(seen)?.params[3], CHANGE_LEAD_IN_CAP + 1);
  assert.equal(windowRead(seen)?.params[3], TIMELINE_LEG_CAP + 1);

  // The band renders FORWARD even though the SQL returns it newest-first, and it
  // keeps the changes NEAREST the incident — the last band row is the newest.
  const band = result.entries.filter((e) => e.kind === "change" && e.at < WINDOW_START);
  assert.equal(band.length, CHANGE_LEAD_IN_CAP);
  assert.deepEqual(band.map((e) => e.at), [...band.map((e) => e.at)].sort());
  assert.equal(band.at(-1)?.key, "chg_lead_00000000", "the band must keep the change nearest the incident");
  assert.ok(band.every((e) => e.at >= LEAD_IN_START), "the band is bounded by CHANGE_LEAD_IN_MS");
  assert.equal(CHANGE_LEAD_IN_MS, 3_600_000);

  // The lead-in is the CHANGES leg's alone (D535): no alert and no error span
  // from before the incident is on this timeline, because none was asked for.
  assert.equal(alertsRead(seen)?.params[1], WINDOW_START);
});

// ---- (8) omissions are per-leg and LOCATABLE ----------------------------------

test("51 rows from one leg yield that leg's own omittedAfterIso, not a boolean (D536)", async () => {
  const alerts = alertRuns(TIMELINE_LEG_CAP + 1);
  const { query, ch } = harness({ alerts, leadIn: leadInRuns(1) });

  const { result } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );

  assert.deepEqual(result.omissions, [
    { leg: "alert", omittedAfterIso: alerts[TIMELINE_LEG_CAP - 1].created_at.toISOString() },
  ]);
  assert.equal(result.entries.filter((e) => e.kind === "alert").length, TIMELINE_LEG_CAP);
  assert.equal(
    result.entries.filter((e) => e.kind === "alert").at(-1)?.at,
    result.omissions[0].omittedAfterIso,
    "the instant is the `at` of the last row the cap KEPT — that is what makes the sentence locatable",
  );
});

test("two legs over the cap yield two omissions at two DIFFERENT instants (D536)", async () => {
  const alerts = alertRuns(TIMELINE_LEG_CAP + 1);
  const errors = errorRuns(TIMELINE_LEG_CAP + 1);
  const { query, ch } = harness({ alerts, errors, changes: changeRuns(2), leadIn: leadInRuns(1) });

  const { result } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );

  assert.deepEqual(
    result.omissions.map((o) => o.leg),
    ["alert", "trace"],
    "a leg that stayed under the cap must not report an omission",
  );
  assert.equal(result.omissions[0].omittedAfterIso, alerts[TIMELINE_LEG_CAP - 1].created_at.toISOString());
  assert.equal(result.omissions[1].omittedAfterIso, iso(errors[TIMELINE_LEG_CAP - 1].first_seen_epoch_s * 1000));
  assert.notEqual(
    result.omissions[0].omittedAfterIso,
    result.omissions[1].omittedAfterIso,
    "one boolean — or one shared instant — cannot say WHICH leg went dark and WHEN",
  );
});

test("there is no merged post-sort cap (D536)", async () => {
  const { query, ch } = harness({
    alerts: alertRuns(TIMELINE_LEG_CAP + 1),
    changes: changeRuns(TIMELINE_LEG_CAP + 1),
    errors: errorRuns(TIMELINE_LEG_CAP + 1),
    leadIn: leadInRuns(CHANGE_LEAD_IN_CAP + 1),
  });

  const { result } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );

  assert.equal(
    result.entries.length,
    3 * TIMELINE_LEG_CAP + CHANGE_LEAD_IN_CAP + 1,
    "a second cap deletes evidence a leg already paid to read, and makes truncation mean two things",
  );
});

// ---- the entries themselves ---------------------------------------------------

test("a change entry's link is EXTERNAL and an alert's is internal — a field, not a branch on kind (D538)", async () => {
  const { query, ch } = harness({
    alerts: [alertRow()],
    changes: [changeRow()],
    errors: [errorRow()],
  });

  const { result } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );

  const byKind = (k: string) => result.entries.find((e) => e.kind === k);
  assert.deepEqual(byKind("change")?.link, {
    label: "workflow run",
    href: "https://example.test/runs/42",
    external: true,
  });
  assert.equal(byKind("alert")?.link?.external, false);
  assert.equal(byKind("alert")?.link?.href, "/app/traces?status=error");
  assert.equal(byKind("trace")?.link?.external, false);
  assert.equal(byKind("trace")?.link?.href, "/app/traces/c9d4e71f3a2b8c56");
});

test("a linkless row carries a null link rather than a fabricated one (D13)", async () => {
  const { query, ch } = harness({
    alerts: [alertRow({ link: null })],
    changes: [changeRow({ link_label: null, link_href: null })],
    errors: [errorRow({ example_trace_id: "" })],
  });

  const { result } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );

  for (const entry of result.entries) {
    assert.equal(entry.link, null, `${entry.kind} invented a link it was not given`);
  }
});

test("the trace entry names the SPAN and the count rides the detail WITH its span (D532)", async () => {
  const { query, ch } = harness({ errors: [errorRow()] });

  const { result } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );

  const trace = result.entries.find((e) => e.kind === "trace");
  assert.equal(trace?.title, "POST /chat on agent-worker");
  assert.doesNotMatch(
    trace?.title ?? "",
    /\d+ error/,
    "a title reading '2 errors on POST /chat' drawn at 13:04 states a number not reached until 13:19",
  );
  assert.equal(
    trace?.detail,
    "2 errors, 2026-09-04 13:04:00 UTC → 2026-09-04 13:19:00 UTC · grouped by service and span",
  );
  assert.equal(trace?.at, "2026-09-04T13:04:00.000Z", "the row is DRAWN at first_seen");
  assert.equal(trace?.until, "2026-09-04T13:19:00.000Z", "…and states its own grain with last_seen");
  assert.equal(result.entries.find((e) => e.kind === "alert")?.until, undefined);
});

test("a point event carries until = null and a single-instant error group says '1 error' (D532)", async () => {
  const at = epochS("2026-09-04T13:07:00.000Z");
  const { query, ch } = harness({
    alerts: [alertRow()],
    changes: [changeRow()],
    errors: [errorRow({ errors: 1, first_seen_epoch_s: at, last_seen_epoch_s: at })],
  });

  const { result } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );

  assert.equal(result.entries.find((e) => e.kind === "alert")?.until, null);
  assert.equal(result.entries.find((e) => e.kind === "change")?.until, null);
  assert.equal(
    result.entries.find((e) => e.kind === "trace")?.detail,
    "1 error, 2026-09-04 13:07:00 UTC · grouped by service and span",
  );
});

test("the resolved row is synthesized from ended_at and is absent while ongoing (D537)", async () => {
  const resolved = harness({ leadIn: leadInRuns(1) });
  const ongoing = harness({ leadIn: leadInRuns(1) });

  const a = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, resolved.ch, resolved.query),
  );
  const b = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, ONGOING, RETENTION_DAYS, PLAN, ongoing.ch, ongoing.query),
  );

  assert.deepEqual(
    a.result.entries.filter((e) => e.kind === "resolved").map((e) => ({ at: e.at, key: e.key, link: e.link })),
    [{ at: WINDOW_END, key: "resolved", link: null }],
  );
  assert.equal(b.result.entries.filter((e) => e.kind === "resolved").length, 0, "an ongoing incident has not resolved");
});

// ---- the four T4-review corrections, each pinned so it cannot regress --------

test("D571: a ZERO-WIDTH incident issues no reads but is NOT told its window predates retention", async () => {
  const { query, seen, ch, chSeen } = harness();
  const at = iso(NOW_INSIDE_RETENTION - 3_600_000);
  const { result } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, { startedAt: at, endedAt: at }, RETENTION_DAYS, PLAN, ch, query),
  );
  assert.equal(seen.length, 0, "a zero-width window still read Postgres");
  assert.equal(chSeen.length, 0, "a zero-width window still read ClickHouse");
  assert.equal(result.outsideRetention, false, "an incident that ended an hour ago was called older than the plan retains");
  assert.ok(result.windowStartIso <= result.windowEndIso, `the window runs backwards: ${result.windowStartIso} > ${result.windowEndIso}`);
});

test("D571: a FUTURE-started ongoing incident is not told its window predates retention, and its window never runs backwards", async () => {
  const { query, seen, ch, chSeen } = harness();
  // server/incidents.ts accepts a start up to INSTANT_SKEW_MS ahead (D527), so
  // an operator whose laptop clock is two minutes fast reaches this by design.
  const startedAt = iso(NOW_INSIDE_RETENTION + 120_000);
  const { result } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, { startedAt, endedAt: null }, RETENTION_DAYS, PLAN, ch, query),
  );
  assert.equal(seen.length, 0);
  assert.equal(chSeen.length, 0);
  assert.equal(result.outsideRetention, false, "a FUTURE window was called older than the plan retains");
  assert.ok(result.windowStartIso <= result.windowEndIso, `the window runs backwards: ${result.windowStartIso} > ${result.windowEndIso}`);
});

test("D573: the lead-in band REPORTS its truncation, in its own direction", async () => {
  const { query, ch } = harness({ leadIn: leadInRuns(CHANGE_LEAD_IN_CAP + 1) });
  const { result } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, RESOLVED, RETENTION_DAYS, PLAN, ch, query),
  );
  const band = result.omissions.find((o) => o.band === true);
  assert.ok(band, "the band read a probe row and reported nothing — 40 changes in the hour and 20 would be indistinguishable");
  assert.equal(band!.leg, "change");
  assert.equal(typeof band!.omittedBeforeIso, "string", "the band's dropped rows are the EARLIEST, so it states a BEFORE instant");
  assert.equal(band!.omittedAfterIso, undefined, "an `after` instant on a descending cap states the opposite of the truth");
});

test("D574: a band clipped by the floor sets inputClipped even when the window's own start was not", async () => {
  const { query, ch } = harness();
  // The floor lands INSIDE the lead-in hour: the window's own start is
  // untouched, ten minutes of the sixty-minute band are readable, and the
  // surface must still render the D507 register.
  const startedAt = iso(NOW_INSIDE_RETENTION - RETENTION_DAYS * 86_400_000 + 600_000);
  const { result } = await withClock(NOW_INSIDE_RETENTION, () =>
    readIncidentTimeline(WS, { startedAt, endedAt: null }, RETENTION_DAYS, PLAN, ch, query),
  );
  assert.equal(result.windowStartIso, startedAt, "pick a start INSIDE the floor: the window's own start must be unclipped");
  assert.equal(result.inputClipped, true, "ten minutes of a sixty-minute band were read and the clip register would not have rendered");
});
