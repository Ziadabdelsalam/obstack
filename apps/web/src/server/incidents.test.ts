import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { QueryResultRow } from "pg";
import {
  IncidentRefusal,
  MAX_INCIDENTS_PER_WORKSPACE,
  MAX_INCIDENT_TITLE,
  NO_SUCH_ALERT_EVENT,
  createIncident,
  deleteIncident,
  getIncident,
  listIncidents,
  listPromotableAlertEvents,
  promoteAlertEvent,
  reopenIncident,
  resolveIncident,
  updateIncident,
  type IncidentInput,
} from "./incidents";
import type { QueryRows } from "./postgres";

// run with: cd apps/web && npx tsx --conditions react-server --test src/server/incidents.test.ts
//
// The incident store's contract with no Postgres at all (the `slos.test.ts` /
// `alerts.test.ts` hermetic half): every statement is bound to the workspace it
// was handed, every mutation takes the D197 advisory lock FIRST, a payload D430
// refuses costs ZERO statements, the promotion's statement ORDER is pinned so a
// later edit cannot move the scoped read after the INSERT (D544), and the SET
// lists name only what their control owns. Whether the rows are actually
// disjoint across two workspaces — and whether the promote leak is really shut
// inside Postgres — is `incidents.integration.test.ts`.

type Statement = { sql: string; params?: unknown[] };

function recordingQuery(reply: (sql: string) => unknown[] = () => []) {
  const seen: Statement[] = [];
  const query: QueryRows = async <Row extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    seen.push({ sql, params });
    return reply(sql) as Row[];
  };
  return { query: query as never, seen };
}

const writes = (seen: Statement[]) => seen.filter((s) => /INSERT|UPDATE|DELETE/.test(s.sql));
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

async function refusal(work: Promise<unknown>, sentence: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof IncidentRefusal, `not an IncidentRefusal: ${String(error)}`);
    assert.equal((error as Error).message, sentence);
    return true;
  });
}

// ---- fixtures ----------------------------------------------------------------------------

const INCIDENT_ID = "inc_00112233445566aa";
const EVENT_ID = "evt_00112233445566aa";
const STARTED = new Date("2026-09-04T13:04:00.000Z");

const row = (over: Record<string, unknown> = {}) => ({
  id: INCIDENT_ID,
  title: "Checkout latency",
  status: "ongoing",
  severity: "critical",
  origin: "manual",
  summary: "p95 over two seconds since the 13:00 deploy",
  impact: "",
  started_at: STARTED,
  ended_at: null,
  opened_from_event_id: null,
  created_at: new Date("2026-09-04T13:05:00.000Z"),
  ongoing_incidents: 1,
  ...over,
});

// `created_at` is TEXT here because the statement casts it: the promoted start
// is copied as Postgres rendered it, microseconds and all.
const event = (over: Record<string, unknown> = {}) => ({
  id: EVENT_ID,
  severity: "warning",
  title: "API availability: breached — 98.4% against a 99.9% target",
  detail: "measured over the last 30 days",
  created_at: "2026-09-04 13:04:00.123456+00",
  ...over,
});

const promotable = (over: Record<string, unknown> = {}) => ({
  id: EVENT_ID,
  severity: "warning",
  title: "API availability: breached",
  created_at: new Date("2026-09-04T13:04:00.000Z"),
  producer: "API availability",
  ...over,
});

const input = (over: Partial<IncidentInput> = {}): IncidentInput => ({
  title: "Checkout latency",
  severity: "critical",
  summary: "p95 over two seconds since the 13:00 deploy",
  impact: "",
  startedAt: "2026-09-04T13:04:00.000Z",
  ...over,
});

type EngineOpts = {
  incident?: ReturnType<typeof row> | null;
  incidents?: ReturnType<typeof row>[];
  count?: number;
  alertEvent?: ReturnType<typeof event> | null;
  promoted?: ReturnType<typeof row> | null;
  events?: ReturnType<typeof promotable>[];
  closed?: boolean;
};

function engine({
  incident = row(),
  incidents = [row()],
  count = 0,
  alertEvent = event(),
  promoted = null,
  events = [promotable()],
  closed = true,
}: EngineOpts = {}) {
  return (sql: string): unknown[] => {
    if (sql.includes("pg_advisory_xact_lock")) return [];
    if (sql.includes("count(*)::int AS n")) return [{ n: count }];
    if (sql.includes("FROM alert_events e") && sql.includes("e.id = $2")) return alertEvent ? [alertEvent] : [];
    if (sql.includes("FROM alert_events e")) return events;
    if (sql.includes("i.opened_from_event_id = $2")) return promoted ? [promoted] : [];
    if (sql.includes("i.id = $2")) return incident ? [incident] : [];
    if (sql.includes("FROM incidents i")) return incidents;
    if (sql.includes("RETURNING id")) return closed ? [{ id: INCIDENT_ID }] : [];
    return [];
  };
}

const MUTATIONS: [string, (query: never) => Promise<unknown>][] = [
  ["createIncident", (q) => createIncident("ws_a", input(), q)],
  ["updateIncident", (q) => updateIncident("ws_a", INCIDENT_ID, input(), q)],
  ["resolveIncident", (q) => resolveIncident("ws_a", INCIDENT_ID, null, q)],
  ["reopenIncident", (q) => reopenIncident("ws_a", INCIDENT_ID, q)],
  ["promoteAlertEvent", (q) => promoteAlertEvent("ws_a", EVENT_ID, q)],
  ["deleteIncident", (q) => deleteIncident("ws_a", INCIDENT_ID, q)],
];

// ---- D7/D11/D113 ------------------------------------------------------------------------------

test("the list read is bound to the workspace it was handed, and carries no limit and no cursor (D529)", async () => {
  const { query, seen } = recordingQuery(engine());
  await listIncidents("ws_a", query);
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /i\.workspace_id = \$1/);
  assert.deepEqual(seen[0].params, ["ws_a"]);
  assert.doesNotMatch(seen[0].sql, /\bLIMIT\b|\bOFFSET\b/, "the cap is the bound: the list takes no limit and no cursor");
  assert.match(seen[0].sql, /ORDER BY i\.started_at DESC, i\.id DESC/);
});

test("the detail read and the picker are bound to the workspace they were handed", async () => {
  const detail = recordingQuery(engine());
  await getIncident("ws_a", INCIDENT_ID, detail.query);
  assert.equal(detail.seen.length, 1);
  assert.match(detail.seen[0].sql, /i\.workspace_id = \$1 AND i\.id = \$2/);
  assert.deepEqual(detail.seen[0].params, ["ws_a", INCIDENT_ID]);

  const picker = recordingQuery(engine());
  await listPromotableAlertEvents("ws_a", 50, picker.query);
  assert.equal(picker.seen.length, 1);
  assert.match(picker.seen[0].sql, /e\.workspace_id = \$1/);
  assert.deepEqual(picker.seen[0].params, ["ws_a", 50]);
});

test("every mutation's statements are bound to the workspace it was handed", async () => {
  for (const [name, run] of MUTATIONS) {
    const { query, seen } = recordingQuery(engine());
    await run(query);
    assert.ok(seen.length > 0, `${name} issued no statements`);
    for (const { sql, params } of seen) {
      assert.match(sql, /workspace_id|pg_advisory_xact_lock\(hashtext\(\$1\)\)/, `${name}: unscoped statement: ${sql}`);
      assert.equal(params?.[0], "ws_a", `${name}: a statement bound ${String(params?.[0])} as its workspace`);
    }
  }
});

test("every mutation takes the workspace advisory lock before it does anything else", async () => {
  for (const [name, run] of MUTATIONS) {
    const { query, seen } = recordingQuery(engine());
    await run(query);
    assert.match(seen[0].sql, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/, `${name} did not lock first`);
    assert.deepEqual(seen[0].params, ["ws_a"]);
  }
});

// ---- D430: shape refusals cost no statement ----------------------------------------------

test("every shape refusal is judged before Postgres and costs no statement", async () => {
  const long = (n: number) => "x".repeat(n);
  const cases: [string, (query: never) => Promise<unknown>, string][] = [
    ["blank title", (q) => createIncident("ws_a", input({ title: "   " }), q), "a title is required"],
    ["title over 200", (q) => createIncident("ws_a", input({ title: long(201) }), q), "the title must be 200 characters or fewer"],
    ["severity outside the vocabulary", (q) => createIncident("ws_a", input({ severity: "page" as never }), q), "severity must be one of critical, warning, info"],
    ["summary over 2000", (q) => createIncident("ws_a", input({ summary: long(2001) }), q), "the summary must be 2000 characters or fewer"],
    ["impact over 500", (q) => createIncident("ws_a", input({ impact: long(501) }), q), "the impact must be 500 characters or fewer"],
    ["summary that is not text", (q) => createIncident("ws_a", input({ summary: 12 as never }), q), "the summary must be text"],
    ["start that is not an instant", (q) => createIncident("ws_a", input({ startedAt: "yesterday" }), q), "the start time must be an ISO instant"],
    ["start in the future", (q) => createIncident("ws_a", input({ startedAt: new Date(Date.now() + 6 * 60_000).toISOString() }), q), "an incident cannot start in the future"],
    ["update with a blank title", (q) => updateIncident("ws_a", INCIDENT_ID, input({ title: "" }), q), "a title is required"],
    ["update with a start in the future", (q) => updateIncident("ws_a", INCIDENT_ID, input({ startedAt: new Date(Date.now() + 6 * 60_000).toISOString() }), q), "an incident cannot start in the future"],
    ["end in the future", (q) => resolveIncident("ws_a", INCIDENT_ID, new Date(Date.now() + 6 * 60_000).toISOString(), q), "an incident cannot end in the future"],
    ["end that is not an instant", (q) => resolveIncident("ws_a", INCIDENT_ID, "just now", q), "the end time must be an ISO instant"],
    ["promote with a blank event id", (q) => promoteAlertEvent("ws_a", "  ", q), NO_SUCH_ALERT_EVENT],
    // A NUL byte is not whitespace, so `.trim()` leaves it and Postgres answers
    // a raw 22021 — a client-reachable 500 past a module whose whole contract
    // here is that a shape refusal is judged BEFORE the database (D430).
    ["promote with a NUL in the event id", (q) => promoteAlertEvent("ws_a", `evt_abc\u0000`, q), NO_SUCH_ALERT_EVENT],
  ];
  for (const [name, run, sentence] of cases) {
    const { query, seen } = recordingQuery(engine());
    await refusal(run(query), sentence);
    assert.deepEqual(seen, [], `${name} reached the database`);
  }
});

// ---- D527: the instant bound is the SERVER's clock ---------------------------------------

test("an instant inside the five-minute skew is accepted and normalised; one beyond it is refused (D527)", async () => {
  const nearFuture = new Date(Date.now() + 4 * 60_000).toISOString();
  const { query, seen } = recordingQuery(engine());
  await createIncident("ws_a", input({ startedAt: nearFuture }), query);
  assert.equal((writes(seen)[0].params as unknown[])[6], nearFuture, "an ordinary skew must not fail an operator's create");

  const offset = recordingQuery(engine());
  await createIncident("ws_a", input({ startedAt: "2026-09-04T15:04:00+02:00" }), offset.query);
  assert.equal(
    (writes(offset.seen)[0].params as unknown[])[6],
    "2026-09-04T13:04:00.000Z",
    "the instant is normalised to ISO UTC at the one place it is checked",
  );

  for (const ahead of [6 * 60_000, 86_400_000, 365 * 86_400_000]) {
    const far = recordingQuery(engine());
    await refusal(
      createIncident("ws_a", input({ startedAt: new Date(Date.now() + ahead).toISOString() }), far.query),
      "an incident cannot start in the future",
    );
    assert.deepEqual(far.seen, []);
  }
});

// ---- D529: the cap, on BOTH insert paths --------------------------------------------------

test("a workspace at the cap is refused on BOTH insert paths, and one below it is not", async () => {
  const SENTENCE = `this workspace already has ${MAX_INCIDENTS_PER_WORKSPACE} incidents — the maximum; delete a resolved one to open another`;

  const created = recordingQuery(engine({ count: MAX_INCIDENTS_PER_WORKSPACE }));
  await refusal(createIncident("ws_a", input(), created.query), SENTENCE);
  assert.deepEqual(writes(created.seen), []);

  const promoted = recordingQuery(engine({ count: MAX_INCIDENTS_PER_WORKSPACE }));
  await refusal(promoteAlertEvent("ws_a", EVENT_ID, promoted.query), SENTENCE);
  assert.deepEqual(writes(promoted.seen), [], "the promote path wrote past the cap — a cap bound only to the create path is not a bound");

  for (const run of [
    (q: never) => createIncident("ws_a", input(), q),
    (q: never) => promoteAlertEvent("ws_a", EVENT_ID, q),
  ]) {
    const below = recordingQuery(engine({ count: MAX_INCIDENTS_PER_WORKSPACE - 1 }));
    await run(below.query);
    assert.equal(writes(below.seen).length, 1);
  }
});

test("the cap is counted under the lock, immediately before each INSERT", async () => {
  for (const [name, run] of [
    ["createIncident", (q: never) => createIncident("ws_a", input(), q)],
    ["promoteAlertEvent", (q: never) => promoteAlertEvent("ws_a", EVENT_ID, q)],
  ] as const) {
    const { query, seen } = recordingQuery(engine());
    await run(query);
    const countAt = seen.findIndex((s) => s.sql.includes("count(*)::int AS n"));
    const insertAt = seen.findIndex((s) => s.sql.includes("INSERT INTO incidents"));
    assert.ok(countAt > 0, `${name} did not count`);
    assert.equal(insertAt, countAt + 1, `${name} put a statement between the count and the INSERT`);
    assert.deepEqual(seen[countAt].params, ["ws_a"]);
  }
});

// ---- D440 --------------------------------------------------------------------------------

test("an incident id this workspace does not hold is the D440 sentence, and nothing is written", async () => {
  for (const [name, run] of [
    ["updateIncident", (q: never) => updateIncident("ws_a", "inc_ffffffffffffffff", input(), q)],
    ["resolveIncident", (q: never) => resolveIncident("ws_a", "inc_ffffffffffffffff", null, q)],
    ["reopenIncident", (q: never) => reopenIncident("ws_a", "inc_ffffffffffffffff", q)],
  ] as const) {
    const { query, seen } = recordingQuery(engine({ incident: null }));
    await refusal(run(query), "no incident with this id in your workspace");
    assert.deepEqual(writes(seen), [], `${name} wrote against an id this workspace does not hold`);
  }
});

test("getIncident answers null rather than throwing, through the same one statement either way (D436/D539)", async () => {
  const hit = recordingQuery(engine());
  const found = await getIncident("ws_a", INCIDENT_ID, hit.query);
  assert.equal(found?.id, INCIDENT_ID);

  const miss = recordingQuery(engine({ incident: null }));
  assert.equal(await getIncident("ws_a", "inc_ffffffffffffffff", miss.query), null);
  assert.equal(miss.seen.length, 1, "a not-found id cost more than the one read a found id costs");
  assert.equal(flat(miss.seen[0].sql), flat(hit.seen[0].sql));
});

test("an alert event id this workspace does not hold is the D440 sentence, and nothing is written", async () => {
  const { query, seen } = recordingQuery(engine({ alertEvent: null }));
  await refusal(promoteAlertEvent("ws_a", "evt_ffffffffffffffff", query), NO_SUCH_ALERT_EVENT);
  assert.equal(NO_SUCH_ALERT_EVENT, "no alert event with this id in your workspace");
  assert.deepEqual(writes(seen), []);
  assert.equal(seen.some((s) => s.sql.includes("count(*)::int AS n")), false, "a miss was counted before it was refused");
});

test("deleting an id this workspace does not hold matches nothing, and the delete answers with nothing (D543)", async () => {
  const { query, seen } = recordingQuery(engine());
  const answer = await deleteIncident("ws_a", "inc_ffffffffffffffff", query);
  assert.equal(answer, undefined);
  assert.equal(seen.length, 2);
  assert.match(seen[1].sql, /DELETE FROM incidents\s+WHERE workspace_id = \$1 AND id = \$2/);
  assert.equal(seen.some((s) => s.sql.includes("FROM incidents i")), false, "a void delete re-read the list");
});

// ---- D544: the promotion's statement ORDER, pinned ---------------------------------------

test("promoteAlertEvent runs its statements in exactly this order — the scoped read before the count and the INSERT", async () => {
  const { query, seen } = recordingQuery(engine());
  await promoteAlertEvent("ws_a", EVENT_ID, query);
  assert.deepEqual(seen.map((s) => flat(s.sql)), [
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    "SELECT e.id, e.severity, e.title, e.detail, e.created_at::text AS created_at FROM alert_events e WHERE e.workspace_id = $1 AND e.id = $2",
    "SELECT i.id, i.title, i.status, i.severity, i.origin, i.summary, i.impact, i.started_at, i.ended_at, i.opened_from_event_id, i.created_at FROM incidents i WHERE i.workspace_id = $1 AND i.opened_from_event_id = $2",
    "SELECT count(*)::int AS n FROM incidents WHERE workspace_id = $1",
    "INSERT INTO incidents (workspace_id, id, title, severity, summary, impact, started_at, origin, opened_from_event_id) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9)",
    "SELECT i.id, i.title, i.status, i.severity, i.origin, i.summary, i.impact, i.started_at, i.ended_at, i.opened_from_event_id, i.created_at FROM incidents i WHERE i.workspace_id = $1 AND i.id = $2",
  ]);
  // Said again as the property, not the transcript: the FK on
  // opened_from_event_id would accept another tenant's event and Postgres would
  // raise nothing, so the scoped read is the tenancy proof and must precede the
  // write it authorises.
  const scopedAt = seen.findIndex((s) => s.sql.includes("FROM alert_events e"));
  const insertAt = seen.findIndex((s) => s.sql.includes("INSERT INTO incidents"));
  assert.ok(scopedAt >= 0 && scopedAt < insertAt);
  assert.deepEqual(seen[scopedAt].params, ["ws_a", EVENT_ID]);
});

test("a promotion derives every value from the event and invents none", async () => {
  const { query, seen } = recordingQuery(engine());
  await promoteAlertEvent("ws_a", EVENT_ID, query);
  const params = writes(seen)[0].params as unknown[];
  assert.match(params[1] as string, /^inc_[0-9a-f]{16}$/);
  assert.equal(params[2], "API availability: breached — 98.4% against a 99.9% target");
  assert.equal(params[3], "warning");
  assert.equal(params[4], "measured over the last 30 days");
  assert.equal(params[5], "", "impact was invented — nothing has measured it");
  assert.equal(params[6], "2026-09-04 13:04:00.123456+00", "the event's own instant was rounded through a JS Date");
  assert.equal(params[7], "alert");
  assert.equal(params[8], EVENT_ID);
});

test("a promoted title longer than the column is clipped at the copy site, with a marker (D526)", async () => {
  const { query, seen } = recordingQuery(engine({ alertEvent: event({ title: "A".repeat(300) }) }));
  await promoteAlertEvent("ws_a", EVENT_ID, query);
  const title = (writes(seen)[0].params as unknown[])[2] as string;
  assert.equal([...title].length, MAX_INCIDENT_TITLE);
  assert.equal(title.endsWith("…"), true);
  assert.equal(title.startsWith("A".repeat(199)), true);

  // Exactly at the bound is copied whole — the clip is not an off-by-one.
  const exact = recordingQuery(engine({ alertEvent: event({ title: "B".repeat(200) }) }));
  await promoteAlertEvent("ws_a", EVENT_ID, exact.query);
  assert.equal((writes(exact.seen)[0].params as unknown[])[2], "B".repeat(200));

  // Astral characters count as ONE to `char_length`, so the clip counts code
  // points: a UTF-16 slice would both overshoot the count and split a pair.
  const astral = recordingQuery(engine({ alertEvent: event({ title: "🛰".repeat(300) }) }));
  await promoteAlertEvent("ws_a", EVENT_ID, astral.query);
  const clipped = (writes(astral.seen)[0].params as unknown[])[2] as string;
  assert.equal([...clipped].length, MAX_INCIDENT_TITLE);
  // No half a character survived: with every well-formed pair removed, nothing
  // in the surrogate range is left. A UTF-16 slice at 199 would leave one.
  assert.doesNotMatch(clipped.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""), /[\uD800-\uDFFF]/);
});

test("an event with a blank title is refused, never written as an empty incident title", async () => {
  const { query, seen } = recordingQuery(engine({ alertEvent: event({ title: "   " }) }));
  await refusal(
    promoteAlertEvent("ws_a", EVENT_ID, query),
    "this alert event has no title — open the incident by hand and give it one",
  );
  assert.deepEqual(writes(seen), []);
});

test("promoting the same event twice returns the ORIGINAL incident and writes nothing (first-write-wins)", async () => {
  const original = row({ id: "inc_aaaabbbbccccdddd", origin: "alert", opened_from_event_id: EVENT_ID });
  const { query, seen } = recordingQuery(engine({ promoted: original }));
  const again = await promoteAlertEvent("ws_a", EVENT_ID, query);
  assert.equal(again.id, "inc_aaaabbbbccccdddd");
  assert.equal(again.origin, "alert");
  assert.equal(again.openedFromEventId, EVENT_ID);
  assert.deepEqual(writes(seen), []);
  assert.equal(seen.some((s) => s.sql.includes("count(*)::int AS n")), false, "an already-promoted event was counted against the cap");
});

// ---- the SET lists ------------------------------------------------------------------------

test("updateIncident's UPDATE names the authored columns only — never status, ended_at, origin or the event pointer", async () => {
  const { query, seen } = recordingQuery(engine());
  await updateIncident("ws_a", INCIDENT_ID, input({ title: "renamed" }), query);
  const [update] = writes(seen);
  assert.match(update.sql, /UPDATE incidents/);
  assert.match(
    update.sql,
    /SET title = \$3, severity = \$4, summary = \$5, impact = \$6, started_at = \$7::timestamptz, updated_at = now\(\)/,
  );
  for (const banned of [/\bstatus\b/, /\bended_at\b/, /\borigin\b/, /opened_from_event_id/]) {
    assert.equal(banned.test(update.sql), false, update.sql);
  }
  assert.deepEqual((update.params as unknown[]).slice(0, 3), ["ws_a", INCIDENT_ID, "renamed"]);
});

test("resolve and reopen move the state pair together, and neither touches the authored columns", async () => {
  const closing = recordingQuery(engine());
  await resolveIncident("ws_a", INCIDENT_ID, null, closing.query);
  const [close] = writes(closing.seen);
  assert.match(close.sql, /SET status = 'resolved', ended_at = coalesce\(\$3::timestamptz, now\(\)\), updated_at = now\(\)/);
  for (const banned of [/\btitle\b/, /\bseverity\b/, /\bsummary\b/, /\bimpact\b/, /\borigin\b/]) {
    assert.equal(banned.test(close.sql), false, close.sql);
  }

  const reopening = recordingQuery(engine({ incident: row({ status: "resolved", ended_at: new Date("2026-09-04T13:26:00Z") }) }));
  await reopenIncident("ws_a", INCIDENT_ID, reopening.query);
  const [reopen] = writes(reopening.seen);
  assert.match(reopen.sql, /SET status = 'ongoing', ended_at = NULL, updated_at = now\(\)/);
});

// ---- D527: the server stamps the end ------------------------------------------------------

test("resolveIncident with no end stamps the SERVER's clock, and never a value from this process", async () => {
  const { query, seen } = recordingQuery(engine());
  await resolveIncident("ws_a", INCIDENT_ID, null, query);
  const [close] = writes(seen);
  assert.equal((close.params as unknown[])[2], null, "an instant from this process was bound as the end");
  assert.match(close.sql, /coalesce\(\$3::timestamptz, now\(\)\)/);

  // A caller who names the end gets that instant, normalised.
  const named = recordingQuery(engine());
  await resolveIncident("ws_a", INCIDENT_ID, "2026-09-04T13:26:00+00:00", named.query);
  assert.equal((writes(named.seen)[0].params as unknown[])[2], "2026-09-04T13:26:00.000Z");
});

test("an end before the start is refused — the caller's instant before the write, the server's by the statement itself", async () => {
  const early = recordingQuery(engine());
  await refusal(
    resolveIncident("ws_a", INCIDENT_ID, "2026-09-04T12:00:00.000Z", early.query),
    "an incident cannot end before it started",
  );
  assert.deepEqual(writes(early.seen), [], "an end before the start reached the table");

  // The server-stamped half: the statement's own `started_at <=` predicate
  // matched no row, which is the only signal this module gets that now() landed
  // before a start inside the skew allowance. It is a refusal, not a 500.
  const guarded = recordingQuery(engine({ closed: false }));
  await refusal(resolveIncident("ws_a", INCIDENT_ID, null, guarded.query), "an incident cannot end before it started");
  assert.match(writes(guarded.seen)[0].sql, /AND started_at <= coalesce\(\$3::timestamptz, now\(\)\)\s+RETURNING id/);
});

// ---- the row mapping ---------------------------------------------------------------------

test("listIncidents maps dates to ISO and carries the derived header's two numbers", async () => {
  const rows = [
    row({ id: "inc_1", started_at: new Date("2026-09-04T13:04:00Z"), ongoing_incidents: 1 }),
    row({ id: "inc_2", status: "resolved", ended_at: new Date("2026-09-03T09:30:00Z"), started_at: new Date("2026-09-03T09:00:00Z"), origin: "alert", opened_from_event_id: EVENT_ID, ongoing_incidents: 1 }),
  ];
  const { query } = recordingQuery(engine({ incidents: rows }));
  const page = await listIncidents("ws_a", query);
  assert.equal(page.total, 2);
  assert.equal(page.ongoing, 1);
  assert.deepEqual(page.incidents.map((i) => i.id), ["inc_1", "inc_2"]);
  assert.equal(page.incidents[0].startedAt, "2026-09-04T13:04:00.000Z");
  assert.equal(page.incidents[0].endedAt, null);
  assert.equal(page.incidents[1].endedAt, "2026-09-03T09:30:00.000Z");
  assert.equal(page.incidents[1].origin, "alert");
  assert.equal(page.incidents[1].openedFromEventId, EVENT_ID);

  const empty = recordingQuery(engine({ incidents: [] }));
  const none = await listIncidents("ws_a", empty.query);
  assert.deepEqual(none, { incidents: [], total: 0, ongoing: 0 });
  assert.equal(empty.seen.length, 1, "an empty list cost a second read to say zero");
});

test("the ongoing count is cast in the statement — what stops pg handing a bigint back as a string (D545)", async () => {
  const { query, seen } = recordingQuery(engine({ incidents: [row({ ongoing_incidents: 3 })] }));
  const page = await listIncidents("ws_a", query);
  assert.equal(typeof page.ongoing, "number");
  assert.equal(page.ongoing, 3);
  // The mechanism, not just the mapped value: the cast is in the SQL, and the
  // count rides the SAME pass as the rows rather than a second read.
  assert.match(seen[0].sql, /\(count\(\*\) FILTER \(WHERE i\.status = 'ongoing'\) OVER \(\)\)::int AS ongoing_incidents/);
  assert.equal(seen.length, 1);
});

test("the picker maps an event to its option shape, producer and all", async () => {
  const { query } = recordingQuery(engine({ events: [promotable(), promotable({ id: "evt_2", producer: null, severity: "info" })] }));
  const options = await listPromotableAlertEvents("ws_a", 50, query);
  assert.deepEqual(options, [
    { id: EVENT_ID, severity: "warning", title: "API availability: breached", at: "2026-09-04T13:04:00.000Z", producer: "API availability" },
    { id: "evt_2", severity: "info", title: "API availability: breached", at: "2026-09-04T13:04:00.000Z", producer: null },
  ]);
});

// ---- the module's own source (the `changes.test.ts` idiom) --------------------------------

const SOURCE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "incidents.ts"), "utf8");

test("the module reads alert_events and never writes it (D544)", () => {
  // Positive control first: an empty result below must mean absence, not a dead
  // regex (S2.0 L1).
  assert.equal((SOURCE.match(/FROM alert_events/g) ?? []).length, 2, "alert_events is read in exactly two statements");
  assert.doesNotMatch(
    SOURCE,
    /INSERT INTO alert_events|UPDATE alert_events|DELETE FROM alert_events/,
    "server/alerts.ts owns alert_events: this module may only read it",
  );
});

test("there is no duplicate-name branch and no unique-violation code anywhere in the module (D524)", () => {
  assert.equal(SOURCE.includes("23505"), false, "0013 carries no UNIQUE (workspace_id, title): a branch on that error is dead code");
  assert.equal(SOURCE.includes("refusingDuplicateName"), false);
  assert.doesNotMatch(SOURCE, /ON CONFLICT/, "refuse, never upsert (D424) — and here there is nothing to conflict on");
});

test("reads take a QueryRows and every mutation demands the transaction brand", () => {
  assert.equal((SOURCE.match(/query: TxQuery/g) ?? []).length, 6, "the six mutations each demand a TxQuery");
  assert.equal((SOURCE.match(/query: QueryRows/g) ?? []).length >= 3, true);
});
