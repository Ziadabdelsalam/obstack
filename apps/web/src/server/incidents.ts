import "server-only";
import { randomBytes } from "node:crypto";
import {
  INCIDENT_SEVERITIES,
  type IncidentListPage,
  type IncidentOrigin,
  type IncidentRow,
  type IncidentSeverity,
  type IncidentStatus,
  type PromotableAlertEvent,
} from "@/lib/incident-types";
import { lockWorkspace, type QueryRows, type TxQuery } from "@/server/postgres";

/**
 * Incidents: the per-workspace objects `/app/incidents` lists and
 * `/app/incidents/[id]` renders, on the `incidents` shape
 * (`services/ingest/pgmigrations/0013_incidents.sql`, packet D542–D545). This
 * is the ONE module that owns incident persistence on the web side. No Go
 * service writes this table and there is no ingest endpoint for it (the
 * sprint's own fence): every row here was typed by a person, or copied from
 * one alert event by `promoteAlertEvent` below.
 *
 * It READS `alert_events` in exactly two statements — the promotion's scoped
 * lookup and the picker's list — and WRITES that table never; `server/alerts.ts`
 * owns it, and a second writer would put two owners on one table.
 *
 * The workspace is a PARAMETER and never ambient (D113), the `alerts.ts` /
 * `slos.ts` rule: every statement below names `workspace_id` and binds this
 * argument as `$1`, and the id comes from the session on the server — never
 * from the client.
 *
 * Every mutation takes the workspace advisory lock FIRST (D195/D197/D199) and
 * demands a `TxQuery`, so the lock — which is transaction-scoped — actually
 * serializes the read→write it wraps; through the plain pool it would release
 * inside its own implicit transaction and serialize nothing. Reads take a plain
 * `QueryRows`.
 *
 * An id from another workspace answers exactly as an invented one does (D440):
 * `NO_SUCH_INCIDENT` and `NO_SUCH_ALERT_EVENT` are the same words for an id
 * that never existed and for another tenant's, and the control flow does not
 * let a caller tell the two apart either.
 *
 * TENANCY, AND THE ONE PLACE IT COULD LEAK (D544). `alert_events.id` is a
 * GLOBAL TEXT primary key, so `opened_from_event_id TEXT REFERENCES
 * alert_events (id)` proves the row EXISTS and says NOTHING about whose it is.
 * The scoped SELECT in `promoteAlertEvent` is the tenancy proof; the foreign
 * key is NOT. Without it, bob POSTing alice's event id to the promote Server
 * Function would insert an incident in BOB's workspace carrying ALICE's title
 * and detail — a real text leak past a green constraint, with Postgres raising
 * nothing at all. That is why the scoped read runs first, before anything is
 * counted or written, and why its position in the statement order is pinned.
 *
 * There is NO duplicate-title refusal here, and no unique-violation branch of
 * any kind, because `0013` carries no `UNIQUE (workspace_id, title)` to violate
 * (D524): two real outages share a title, and the promotion path COPIES the
 * alert's title, so a recurring rule mints the same string by construction. A
 * branch on an error the database cannot raise is dead code that reads as a
 * live rule — worse than no branch at all — so it is absent DELIBERATELY. Do
 * not add one back for house-style symmetry with `slos.ts`.
 *
 * `listIncidents` takes no limit and no cursor (D529): the per-workspace cap IS
 * the bound, counted under the lock on BOTH insert paths, so every row a
 * workspace holds is reachable in one read and a capped workspace can always
 * get back under the cap. `incidents` is never swept by retention (D528) — the
 * cap, the DDL's length CHECKs and the workspace cascade are the whole bound.
 */

/** Every refusal this module raises, as one class the action catches by
 *  identity (the `SloRefusal`/`AlertRefusal` precedent). Its message is the
 *  sentence the surface prints VERBATIM. */
export class IncidentRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentRefusal";
  }
}

/** D440: the same words for an id that never existed and for another tenant's.
 *  `NO_SUCH_ALERT_EVENT` is exported because the promote control prints it and
 *  the wording is pinned in one place. */
const NO_SUCH_INCIDENT = "no incident with this id in your workspace";
export const NO_SUCH_ALERT_EVENT = "no alert event with this id in your workspace";

/** App-generated ids, the `rule_`/`chan_`/`evt_`/`slo_`/`chg_` idiom (D437/D116). */
const newIncidentId = (): string => `inc_${randomBytes(8).toString("hex")}`;

/** D529: the abuse bound on the one table retention never sweeps. It is not an
 *  eval-cadence bound (200 rules) nor a query-cost bound (50 SLOs) — an
 *  incident costs nothing per tick — so it sits far above any honest lifetime,
 *  roughly one incident a week for a decade. Counted under the same lock the
 *  INSERT runs under, on BOTH insert paths: a cap bound only to the path a
 *  click cannot repeat is not a bound. */
export const MAX_INCIDENTS_PER_WORKSPACE = 500;

/** The DDL's own CHECKs (`0013_incidents.sql:87,91,92`), judged here so a
 *  constraint never surfaces as a 500 (the 0011 header's rule). `MAX_INCIDENT_TITLE`
 *  is exported because promotion CLIPS to it at the copy site (D526):
 *  `alert_events.title` carries no length CHECK and neither do its inputs, so a
 *  long rule name mints an over-long event title today. */
export const MAX_INCIDENT_TITLE = 200;
const MAX_INCIDENT_SUMMARY = 2000;
const MAX_INCIDENT_IMPACT = 500;

/** D527: how far ahead of the SERVER's clock an instant may sit before it is
 *  refused — the `futureAllowance` precedent in `changes/document.go`. A
 *  client-supplied `startedAt` is reachable by direct POST to a Server
 *  Function, and without this bound it would pin a row at the top of a
 *  `started_at DESC` list forever, with a nonsense duration beside it. */
const INSTANT_SKEW_MS = 5 * 60_000;

// ---- row shapes as Postgres returns them -------------------------------------

/** `pg` hands TIMESTAMPTZ back as a `Date`; it becomes an ISO string at the one
 *  place the row is mapped, never at a call site. */
type Row = {
  id: string;
  title: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  origin: IncidentOrigin;
  summary: string;
  impact: string;
  started_at: Date;
  ended_at: Date | null;
  opened_from_event_id: string | null;
  created_at: Date;
};

/** The list read carries the derived header's ongoing count on every row (D545). */
type ListRow = Row & { ongoing_incidents: number };

/** The promotion's projection: the smallest set of columns that can answer it
 *  (D544). No `channel_id`, no `delivery`, no `link` — a column this path does
 *  not need is a column it cannot leak.
 *
 *  `created_at` comes back as TEXT on purpose. It is COPIED into
 *  `incidents.started_at`, and a `Date` is millisecond-precision while
 *  TIMESTAMPTZ is microsecond: routing the instant through JS would silently
 *  round the copy, so the promoted incident's window would differ from the
 *  event's own instant by up to a millisecond. The text Postgres rendered goes
 *  straight back to Postgres. */
type PromotionEventRow = {
  id: string;
  severity: IncidentSeverity;
  title: string;
  detail: string;
  created_at: string;
};

/** The picker's projection (D541): a label, never an id, for `producer`. */
type PromotableRow = {
  id: string;
  severity: IncidentSeverity;
  title: string;
  created_at: Date;
  producer: string | null;
};

const iso = (at: Date | null): string | null => (at ? at.toISOString() : null);

const toRow = (row: Row): IncidentRow => ({
  id: row.id,
  title: row.title,
  status: row.status,
  severity: row.severity,
  origin: row.origin,
  summary: row.summary,
  impact: row.impact,
  startedAt: row.started_at.toISOString(),
  endedAt: iso(row.ended_at),
  openedFromEventId: row.opened_from_event_id,
  createdAt: row.created_at.toISOString(),
});

const toPromotable = (row: PromotableRow): PromotableAlertEvent => ({
  id: row.id,
  severity: row.severity,
  title: row.title,
  at: row.created_at.toISOString(),
  producer: row.producer,
});

// ---- statements: workspace_id leads every one, $1-bound ---------------------

const COLUMNS = `i.id, i.title, i.status, i.severity, i.origin, i.summary, i.impact,
         i.started_at, i.ended_at, i.opened_from_event_id, i.created_at`;

/**
 * The whole list, newest-first by the incident's OWN start — the `changes.ts`
 * rule, deliberately not `listSlos`' `created_at, name`: an incident sorts
 * where it happened, and `id DESC` breaks ties so two incidents opened at one
 * instant render in a stable order.
 *
 * NO LIMIT and no cursor (D529). A 500-cap with a 100-row page and no cursor
 * would be an unrecoverable dead end — refusing new incidents while hiding the
 * 400 the operator would have to delete to get under it.
 *
 * The derived header's ongoing count rides the SAME pass as a window
 * aggregate. The `::int` is what stops `pg` handing a bigint back as a STRING;
 * the parenthesised form is one canonical spelling, not a workaround for a
 * parse (the bare form parses correctly).
 */
const LIST_INCIDENTS_SQL = `
  SELECT ${COLUMNS},
         (count(*) FILTER (WHERE i.status = 'ongoing') OVER ())::int AS ongoing_incidents
    FROM incidents i
   WHERE i.workspace_id = $1
   ORDER BY i.started_at DESC, i.id DESC`;

const GET_INCIDENT_SQL = `
  SELECT ${COLUMNS}
    FROM incidents i
   WHERE i.workspace_id = $1 AND i.id = $2`;

/** Both insert paths share this one statement, so `origin` and
 *  `opened_from_event_id` are BOUND values and not two spellings that can
 *  drift: `('manual', NULL)` from `createIncident`, `('alert', evt_…)` from
 *  `promoteAlertEvent`. `status`, `ended_at`, `created_at` and `updated_at` are
 *  the DDL's defaults — a new incident is ongoing and has no end, which is the
 *  both-or-neither CHECK's legal half. */
const INSERT_INCIDENT_SQL = `
  INSERT INTO incidents (workspace_id, id, title, severity, summary, impact, started_at, origin, opened_from_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9)`;

/** The editable content only. Never `status` or `ended_at` (the resolve/reopen
 *  controls own the state pair, and the table CHECK ties them together), never
 *  `origin` or `opened_from_event_id` (how an incident came to exist is a fact
 *  about the past, set once at insert and never rewritten — D526). */
const UPDATE_INCIDENT_SQL = `
  UPDATE incidents
     SET title = $3, severity = $4, summary = $5, impact = $6, started_at = $7::timestamptz, updated_at = now()
   WHERE workspace_id = $1 AND id = $2`;

/**
 * Close it. `$3` is the caller's end or NULL, and NULL means the SERVER's own
 * clock (D527) — never the browser's, which is the one clock in the system no
 * server can vouch for.
 *
 * The `started_at <=` predicate is the same rule against that server clock: it
 * is the only place the default end exists, so it is the only place the
 * `ended_at >= started_at` CHECK could be reached with a value nothing in this
 * process chose. No row updated means the guard refused, and `RETURNING id` is
 * how this module learns that — a refusal with the field named, never a
 * constraint surfacing as a 500.
 */
const RESOLVE_INCIDENT_SQL = `
  UPDATE incidents
     SET status = 'resolved', ended_at = coalesce($3::timestamptz, now()), updated_at = now()
   WHERE workspace_id = $1 AND id = $2
     AND started_at <= coalesce($3::timestamptz, now())
   RETURNING id`;

/** Reopen it: the pair moves together, which is exactly what the
 *  `(status = 'resolved') = (ended_at IS NOT NULL)` CHECK demands. The end
 *  instant is dropped rather than kept, because an ongoing incident that
 *  remembers an end is the inconsistency the CHECK exists to make
 *  unrepresentable. */
const REOPEN_INCIDENT_SQL = `
  UPDATE incidents
     SET status = 'ongoing', ended_at = NULL, updated_at = now()
   WHERE workspace_id = $1 AND id = $2`;

const DELETE_INCIDENT_SQL = `
  DELETE FROM incidents
   WHERE workspace_id = $1 AND id = $2`;

const COUNT_INCIDENTS_SQL = `
  SELECT count(*)::int AS n
    FROM incidents
   WHERE workspace_id = $1`;

/** D544: the tenancy proof, and the smallest projection that can answer the
 *  promotion — id, severity, title, detail, created_at. The `alert_events`
 *  scoped-existence posture is `alerts.ts`'s `CHANNEL_EXISTS_SQL` one step
 *  further: a statement that never selects a column this path does not need
 *  cannot leak one even if a caller misused it. */
const ALERT_EVENT_FOR_PROMOTION_SQL = `
  SELECT e.id, e.severity, e.title, e.detail, e.created_at::text AS created_at
    FROM alert_events e
   WHERE e.workspace_id = $1 AND e.id = $2`;

/** Already promoted? The partial UNIQUE index on `opened_from_event_id`
 *  (`0013:130`) makes at most one such row exist, and this read is what turns a
 *  second promotion into the ORIGINAL row rather than a unique violation:
 *  first-write-wins, not a refusal — a double click is not an error. */
const INCIDENT_FOR_ALERT_EVENT_SQL = `
  SELECT ${COLUMNS}
    FROM incidents i
   WHERE i.workspace_id = $1 AND i.opened_from_event_id = $2`;

/**
 * The promote picker's list: this workspace's alert events that no incident was
 * opened from, newest first. Every un-promoted event is offered, `info`
 * included (D525) — a severity filter on a picker reads as a broken control.
 *
 * The producer is `alert_rules.name` or `slos.name`, whichever emitted the
 * event, or NULL for a rule-less test notification (D491): a LABEL, never an
 * id, and both joins are LEFT for the same reason `LIST_EVENTS_SQL` keeps them.
 *
 * The correlated `NOT EXISTS`'s own `i.workspace_id = $1` is PROVABLY redundant
 * — `alert_events.id` is a global primary key and the only writer of
 * `opened_from_event_id` is `promoteAlertEvent`, which proves the event is this
 * workspace's before it points at it, so an incident in another workspace
 * cannot hold this event's id. It is kept because every statement in this
 * module names the workspace it was handed, and a reader should not have to
 * reconstruct that proof to be sure of the subquery. The OUTER predicate is the
 * one that is load-bearing.
 */
const LIST_PROMOTABLE_ALERT_EVENTS_SQL = `
  SELECT e.id, e.severity, e.title, e.created_at,
         coalesce(r.name, s.name) AS producer
    FROM alert_events e
    LEFT JOIN alert_rules r ON r.id = e.rule_id
    LEFT JOIN slos s ON s.id = e.slo_id
   WHERE e.workspace_id = $1
     AND NOT EXISTS (SELECT 1
                       FROM incidents i
                      WHERE i.workspace_id = $1 AND i.opened_from_event_id = e.id)
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT $2`;

// ---- validation (D430: judged before the lock, costs no statement) ---------
//
// Every length below is judged in JS UTF-16 code units against a Postgres
// `char_length`, which counts CHARACTERS. The two agree on the BMP and differ
// on astral characters, where JS counts 2 and Postgres counts 1 — so this side
// is always the stricter one and a CHECK can never be reached by a value this
// side allowed. The clip in `clippedEventTitle` is the one place that matters
// in the other direction, and it counts code points for exactly that reason.

function checkedTitle(title: unknown): string {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (!trimmed) throw new IncidentRefusal("a title is required");
  if (trimmed.length > MAX_INCIDENT_TITLE) {
    throw new IncidentRefusal(`the title must be ${MAX_INCIDENT_TITLE} characters or fewer`);
  }
  return trimmed;
}

function checkedSeverity(severity: unknown): IncidentSeverity {
  if (!INCIDENT_SEVERITIES.includes(severity as IncidentSeverity)) {
    throw new IncidentRefusal(`severity must be one of ${INCIDENT_SEVERITIES.join(", ")}`);
  }
  return severity as IncidentSeverity;
}

/** `summary` and `impact` are NOT NULL DEFAULT '' columns: "the operator typed
 *  none" is the empty string, never null. An absent field is that; anything
 *  that is not text is a bug in the caller and is refused rather than coerced. */
function checkedText(value: unknown, field: "summary" | "impact", max: number): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new IncidentRefusal(`the ${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new IncidentRefusal(`the ${field} must be ${max} characters or fewer`);
  return trimmed;
}

/**
 * D527: an instant, bounded against the SERVER's clock and normalised to ISO
 * UTC.
 *
 * More than `INSTANT_SKEW_MS` ahead is refused. Ordinary client/server skew is
 * a few seconds and must not fail an operator's create; an incident dated next
 * March is not skew, and it would sit at the top of a `started_at DESC` list
 * forever with a duration counting DOWN. The allowance is the bound between
 * those two, and it is measured here rather than in the database because the
 * refusal has to name the field.
 */
function checkedInstant(value: unknown, field: "start" | "end"): string {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new IncidentRefusal(`the ${field} time must be an ISO instant`);
  if (ms > Date.now() + INSTANT_SKEW_MS) throw new IncidentRefusal(`an incident cannot ${field} in the future`);
  return new Date(ms).toISOString();
}

/** An id is a string the caller was handed by this product; a blank one never
 *  existed, and answering it in the D440 words costs no statement. */
function checkedEventId(eventId: unknown): string {
  const trimmed = typeof eventId === "string" ? eventId.trim() : "";
  // A NUL byte is not whitespace, so `.trim()` leaves it and Postgres answers
  // 22021 ("invalid byte sequence for encoding UTF8") — a RAW error, past a
  // module whose contract (D430) is that a shape refusal is judged here and
  // costs no statement. No id this product hands out contains one.
  if (!trimmed || trimmed.includes("\u0000")) throw new IncidentRefusal(NO_SUCH_ALERT_EVENT);
  return trimmed;
}

/**
 * The promoted title, CLIPPED at the copy site (D526).
 *
 * `alert_events.title` has NO length CHECK (`0010:77` is `title TEXT NOT NULL`)
 * and neither do its inputs — `alert_rules.name` and `slos.name` carry only
 * `CHECK (name <> '')`, and `event_text.go` composes the title from them — so a
 * long rule name mints an event title over 200 characters today, and an
 * unclipped copy would raise the `incidents.title` CHECK. A constraint must
 * never surface as a 500, so the copy is clipped with a stated marker instead.
 *
 * Code points, not UTF-16 units: `char_length` counts characters, and slicing
 * on units could also split a surrogate pair and copy half a character.
 *
 * A BLANK event title is a refusal, never a 23514 — `alert_events.title` is
 * NOT NULL but may legally be empty, and `incidents.title` may not.
 */
function clippedEventTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new IncidentRefusal("this alert event has no title — open the incident by hand and give it one");
  }
  const points = [...trimmed];
  if (points.length <= MAX_INCIDENT_TITLE) return trimmed;
  return `${points.slice(0, MAX_INCIDENT_TITLE - 1).join("")}…`;
}

/**
 * The event's `detail`, clipped to what `incidents.summary` accepts.
 *
 * D526 rules that title AND summary are clipped at the copy site. The argument
 * is the same one, one column over: `alert_events.detail` is `TEXT NOT NULL
 * DEFAULT ''` with NO length CHECK (`0010_alerts.sql:78`), its content is
 * composed by `event_text.go` from a rule name and every `k=v` filter pair —
 * none of which `validateAlertCondition` or `checkedName` bound — and
 * `incidents.summary` CHECKs at 2000. So an ordinary alert event can carry a
 * detail this column refuses, and an unclipped copy raises 23514 as a RAW pg
 * error: not an `IncidentRefusal`, so the action cannot catch it by identity
 * and the sprint's headline creation path answers 500. That is exactly the
 * failure the copy-site clip exists to prevent.
 *
 * Unlike the title there is no blank refusal: `incidents.summary` is NOT NULL
 * DEFAULT '' and an empty summary is legal, where an empty title is not.
 */
function clippedEventSummary(detail: string): string {
  const points = [...detail];
  if (points.length <= MAX_INCIDENT_SUMMARY) return detail;
  return `${points.slice(0, MAX_INCIDENT_SUMMARY - 1).join("")}…`;
}

/** The full editable shape — everything `createIncident` and `updateIncident`
 *  accept. `status`/`endedAt` are deliberately NOT here: they are
 *  `resolveIncident`/`reopenIncident`'s alone, and `origin`/`openedFromEventId`
 *  belong to no caller at all. */
export interface IncidentInput {
  title: string;
  severity: IncidentSeverity;
  summary: string;
  impact: string;
  /** ISO UTC, bounded against the server clock (D527). */
  startedAt: string;
}

type CheckedInput = {
  title: string;
  severity: IncidentSeverity;
  summary: string;
  impact: string;
  startedAt: string;
};

/** Shape checks only — no statement runs from here (D430). */
function checkedInput(input: IncidentInput): CheckedInput {
  return {
    title: checkedTitle(input.title),
    severity: checkedSeverity(input.severity),
    summary: checkedText(input.summary, "summary", MAX_INCIDENT_SUMMARY),
    impact: checkedText(input.impact, "impact", MAX_INCIDENT_IMPACT),
    startedAt: checkedInstant(input.startedAt, "start"),
  };
}

async function assertUnderCap(workspaceId: string, query: QueryRows): Promise<void> {
  const [{ n }] = await query<{ n: number }>(COUNT_INCIDENTS_SQL, [workspaceId]);
  if (n >= MAX_INCIDENTS_PER_WORKSPACE) {
    throw new IncidentRefusal(
      `this workspace already has ${MAX_INCIDENTS_PER_WORKSPACE} incidents — the maximum; delete a resolved one to open another`,
    );
  }
}

async function readRow(workspaceId: string, id: string, query: QueryRows): Promise<Row> {
  const [row] = await query<Row>(GET_INCIDENT_SQL, [workspaceId, id]);
  if (!row) throw new IncidentRefusal(NO_SUCH_INCIDENT);
  return row;
}

async function readBack(workspaceId: string, id: string, query: QueryRows): Promise<IncidentRow> {
  return toRow(await readRow(workspaceId, id, query));
}

// ---- reads (packet §0) ------------------------------------------------------

/**
 * This workspace's incidents, newest-first, plus the derived header's two
 * numbers (D545).
 *
 * `total` is the row count itself — there is no LIMIT, so the list IS the
 * total. `ongoing` rides every row as the same window aggregate; an empty list
 * has no row to carry it and is 0 by construction rather than by a second read.
 *
 * The header this feeds reads `{ongoing} ongoing · {total} total` and never
 * `1 in the last 7 days`: this read applies no time predicate, and reproducing
 * that sentence would be a claim about a filter that does not exist.
 */
export async function listIncidents(workspaceId: string, query: QueryRows): Promise<IncidentListPage> {
  const rows = await query<ListRow>(LIST_INCIDENTS_SQL, [workspaceId]);
  return {
    incidents: rows.map(toRow),
    total: rows.length,
    ongoing: rows.length === 0 ? 0 : rows[0].ongoing_incidents,
  };
}

/**
 * One incident, or `null` when this workspace holds no such id — NOT a throw.
 *
 * The detail page renders the D436 not-found sentence from this, and a bogus id
 * and another tenant's id reach it through exactly the same statement with the
 * same zero telemetry behind it (D440/D539).
 */
export async function getIncident(workspaceId: string, id: string, query: QueryRows): Promise<IncidentRow | null> {
  const [row] = await query<Row>(GET_INCIDENT_SQL, [workspaceId, id]);
  return row ? toRow(row) : null;
}

/** The promote picker's options: this workspace's un-promoted alert events,
 *  newest first, bounded by the caller's limit in the `listAlertEvents` shape
 *  (`alert_events` grows at machine rate, so unlike `listIncidents` this read
 *  has no cap of its own to lean on). */
export async function listPromotableAlertEvents(
  workspaceId: string,
  limit: number,
  query: QueryRows,
): Promise<PromotableAlertEvent[]> {
  const n = Math.max(1, Math.floor(limit) || 1);
  const rows = await query<PromotableRow>(LIST_PROMOTABLE_ALERT_EVENTS_SQL, [workspaceId, n]);
  return rows.map(toPromotable);
}

// ---- mutations ---------------------------------------------------------------

/** Open an incident by hand. Shape is judged before the lock; the cap is
 *  counted under it, immediately before the INSERT, so nothing can slip a row
 *  in between the count and the write. `origin = 'manual'` and no event
 *  pointer: this one was not promoted from anything. */
export async function createIncident(workspaceId: string, input: IncidentInput, query: TxQuery): Promise<IncidentRow> {
  const checked = checkedInput(input);
  await lockWorkspace(query, workspaceId);
  await assertUnderCap(workspaceId, query);

  const id = newIncidentId();
  await query(INSERT_INCIDENT_SQL, [
    workspaceId,
    id,
    checked.title,
    checked.severity,
    checked.summary,
    checked.impact,
    checked.startedAt,
    "manual" satisfies IncidentOrigin,
    null,
  ]);
  return readBack(workspaceId, id, query);
}

/**
 * Edit an incident's authored content. Never its state pair, never its origin.
 *
 * The one cross-column rule this can reach is the `ended_at >= started_at`
 * CHECK — moving the start of a RESOLVED incident past its end — and it is
 * refused here with the field named, against the row as it stands under the
 * lock, so the constraint never surfaces as a 500.
 */
export async function updateIncident(
  workspaceId: string,
  id: string,
  input: IncidentInput,
  query: TxQuery,
): Promise<IncidentRow> {
  const checked = checkedInput(input);
  await lockWorkspace(query, workspaceId);
  const before = await readRow(workspaceId, id, query);
  if (before.ended_at !== null && Date.parse(checked.startedAt) > before.ended_at.getTime()) {
    throw new IncidentRefusal("an incident cannot start after it ended");
  }

  await query(UPDATE_INCIDENT_SQL, [
    workspaceId,
    id,
    checked.title,
    checked.severity,
    checked.summary,
    checked.impact,
    checked.startedAt,
  ]);
  return readBack(workspaceId, id, query);
}

/**
 * Close an incident (D527). `endedAt` is the caller's instant or `null`, and
 * `null` means the SERVER's `now()` — the browser's clock never lands in this
 * column.
 *
 * An end before the start is refused twice over, because there are two ways to
 * reach it: a caller-supplied end is compared here against the row read under
 * the lock, and the server-stamped default is guarded by the statement's own
 * `started_at <=` predicate, which is the only place a value nothing in this
 * process chose could reach the CHECK.
 */
export async function resolveIncident(
  workspaceId: string,
  id: string,
  endedAt: string | null,
  query: TxQuery,
): Promise<IncidentRow> {
  const end = endedAt === null || endedAt === undefined ? null : checkedInstant(endedAt, "end");
  await lockWorkspace(query, workspaceId);
  const before = await readRow(workspaceId, id, query);
  if (end !== null && Date.parse(end) < before.started_at.getTime()) {
    throw new IncidentRefusal("an incident cannot end before it started");
  }

  const closed = await query<{ id: string }>(RESOLVE_INCIDENT_SQL, [workspaceId, id, end]);
  if (closed.length === 0) throw new IncidentRefusal("an incident cannot end before it started");
  return readBack(workspaceId, id, query);
}

/** Reopen a closed incident: the state pair moves back together. Reopening one
 *  that is already ongoing writes the state it already has — the control that
 *  offers this is only rendered on a resolved incident, and a stale tab
 *  repeating it is not an error worth a sentence. */
export async function reopenIncident(workspaceId: string, id: string, query: TxQuery): Promise<IncidentRow> {
  await lockWorkspace(query, workspaceId);
  await readRow(workspaceId, id, query);

  await query(REOPEN_INCIDENT_SQL, [workspaceId, id]);
  return readBack(workspaceId, id, query);
}

/**
 * Open an incident FROM an alert event (D544), in this exact statement order:
 * lock → the scoped event read → the already-promoted read → the cap → the
 * INSERT → the read back.
 *
 * The order is the tenancy proof and is pinned as such. The scoped SELECT runs
 * before anything is counted or written, because `alert_events.id` is a global
 * primary key: the foreign key on `opened_from_event_id` would be satisfied by
 * ANOTHER tenant's event, Postgres would raise nothing, and the INSERT would
 * copy that tenant's title and detail into this workspace.
 *
 * Every value is DERIVED, never invented: the title is the event's, clipped;
 * the severity is the event's, identity-mapped (the vocabularies are the same
 * three members, so there is no mapping to overstate or understate — D525); the
 * summary is the event's detail; the impact is EMPTY because nothing has
 * measured impact and the operator types it; the start is the event's own
 * `created_at`, copied as text so the instant is exact.
 *
 * A second promotion of the same event returns the ORIGINAL row: first-write
 * wins, and a double click is not an error.
 */
export async function promoteAlertEvent(workspaceId: string, eventId: string, query: TxQuery): Promise<IncidentRow> {
  const checkedId = checkedEventId(eventId);
  await lockWorkspace(query, workspaceId);

  const [event] = await query<PromotionEventRow>(ALERT_EVENT_FOR_PROMOTION_SQL, [workspaceId, checkedId]);
  if (!event) throw new IncidentRefusal(NO_SUCH_ALERT_EVENT);

  const [already] = await query<Row>(INCIDENT_FOR_ALERT_EVENT_SQL, [workspaceId, checkedId]);
  if (already) return toRow(already);

  const title = clippedEventTitle(event.title);
  const summary = clippedEventSummary(event.detail);
  await assertUnderCap(workspaceId, query);

  const id = newIncidentId();
  await query(INSERT_INCIDENT_SQL, [
    workspaceId,
    id,
    title,
    event.severity,
    summary,
    "",
    event.created_at,
    "alert" satisfies IncidentOrigin,
    event.id,
  ]);
  return readBack(workspaceId, id, query);
}

/**
 * Drop an incident, and answer with nothing (D543).
 *
 * The `deleteSlo` precedent returns the remaining list because an SLO card
 * re-renders in place; this surface's header is DERIVED (`{ongoing} ongoing ·
 * {total} total`), which a bare row array could not restate, so the caller
 * refreshes the route instead and the list read recomputes both numbers.
 *
 * An id this workspace does not hold matches no row and is silent — the same
 * answer a stale tab gets, which is the D440 shape for a delete.
 */
export async function deleteIncident(workspaceId: string, id: string, query: TxQuery): Promise<void> {
  await lockWorkspace(query, workspaceId);
  await query(DELETE_INCIDENT_SQL, [workspaceId, id]);
}
