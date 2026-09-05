import "server-only";
import type { ScopedClickHouse } from "@/server/clickhouse";

/**
 * The incident timeline's TRACE leg (S7.4 packet D531/D532/D534/D536).
 *
 * One bounded read of `obstack.spans`: this workspace's error spans inside the
 * incident window, grouped by `(service, span name)`, each row carrying the
 * instant it starts at, the instant it stops at, and one example trace.
 *
 * ---- why `obstack.spans` and NOT `obstack.trace_summaries` (D531) ----
 *
 * Two independent reasons, both measured against this repo's own DDL and the
 * pinned engine (26.3.17.110):
 *
 *  1. `spans` is `PARTITION BY toDate(start_time)` (`0001_spans.sql:44`), so the
 *     two-sided bound below is a genuine partition prune. `trace_summaries` has
 *     NO `PARTITION BY` at all (`0003_trace_summaries.sql:39-41` —
 *     `AggregatingMergeTree ORDER BY (workspace_id, trace_id)`, TTL only); its
 *     `max_seen_date >= …` filter is an ordinary Date column filter that the
 *     repo's older comments loosely call a "partition prune", and for a bounded
 *     HISTORICAL window that is exactly backwards. Measured here with
 *     `EXPLAIN ESTIMATE` over the compose store: with both bounds, `parts 1 /
 *     rows 8192 / marks 1`; with the bounds removed, `parts 2 / rows 16369 /
 *     marks 2`.
 *  2. `eval_slo.go` bounds the merged `min(min_start)` — the TRACE's start. A
 *     trace that began before the incident and errored twelve minutes into it is
 *     invisible to that shape, and that erroring span's instant is precisely
 *     what a timeline row has to be drawn at. A summaries read cannot answer the
 *     question this leg asks; it can only answer a different one.
 *
 * ---- the clauses, and what each is load-bearing for ----
 *
 * `{workspace_id:String}` is literally present because `runScoped`'s text
 * tripwire refuses SQL without it (`clickhouse.ts:41,69-73`) — the binding is
 * injected whether or not the caller asks, so the only leak left to catch is a
 * statement that binds the scope and then filters on nothing.
 *
 * `trace_id != ''` is load-bearing, and its reason is NOT the one D531 states
 * (corrected as D570; the ruling stands, the mechanism did not). D531 says the
 * clause is needed because `trace_summaries_mv` has no write-side trace-id
 * filter. That sentence is `traces.integration.test.ts:753-757`'s, where it is
 * true — but it is true of a read of `trace_summaries`, and this is a read of
 * `obstack.spans`. The MV is a CONSUMER of this table
 * (`0003_trace_summaries.sql:63` is `FROM obstack.spans`), so what it does or
 * does not filter cannot be why `spans` holds anything. Measured the other way:
 * the OTLP path CANNOT write an empty trace id here — `mapping/spans.go:44-46`
 * fails `mapSpan` on `span.TraceID().IsEmpty()` and `SpanRows` drops the span
 * with `metrics.Dropped{reason=mapping}` before the writer sees it.
 *
 * The clause is kept because the mapper is not the only writer. Anything holding
 * the `obstack_ingest` grant inserts straight into the table past `mapSpan` —
 * which is how every integration test in this repo seeds, and how a backfill, an
 * import or a migration repair would write. That is not hypothetical: the
 * compose store holds 17 such rows today, every one of them
 * `POST /orphan-no-trace-id` in a `ws_it_*` workspace, i.e.
 * `traces.integration.test.ts`'s own fixture.
 *
 * And the failure it prevents is silent and asymmetric: without the clause
 * `argMin` returns `''`, and `/app/traces/` + an empty id is the traces LIST, so
 * a reader who clicks "example trace" mid-incident lands on every trace in the
 * workspace — none of which errored. A clause that costs nothing and prevents a
 * fabricated link stays, on that reason rather than on the transplanted one.
 *
 * `argMin`, deliberately NOT `issues.ts:105`'s `argMax`. The entry is DRAWN at
 * `first_seen` (D532), so an `argMax` example would link a trace that ran twenty
 * minutes after the moment the row sits at. Same aggregate, opposite end of the
 * grain, and only one of them matches where the row is rendered.
 *
 * `ORDER BY first_seen_epoch_s, service, span_name` — chronological, NOT by
 * count. The list is capped, and a cap on a RANKED list deletes the quiet tail
 * (the two-error span nobody would have found without the timeline); a cap on a
 * chronological one deletes only the tail, which is the one truncation a
 * timeline can survive and the one the caller can state (D536). `service` and
 * `span_name` break the instant tie so the LIMIT is deterministic rather than
 * whichever row the engine happened to emit first.
 *
 * The bound is half-open `[since, until)` (D534): incident windows are adjacent,
 * so with a closed upper bound two back-to-back incidents would both claim the
 * error at the shared instant with no way to say which owned it. This is a NEW
 * shape — `metrics.ts:193-195` is the only read in `queries/` that binds an
 * upper bound at all, and no read of `spans` or `trace_summaries` had one before
 * this one.
 *
 * The `_epoch_s` alias suffix follows `issues.ts:92-93`: an aggregate may not
 * carry the name of the column it aggregates without tripping
 * `ILLEGAL_AGGREGATION`, and keeping the house suffix means a later editor who
 * wraps one of these in another aggregate hits the same familiar error.
 */
const INCIDENT_ERRORS_SQL = `
SELECT service, name AS span_name, toUInt32(count()) AS errors,
       toUInt32(min(toUnixTimestamp(start_time))) AS first_seen_epoch_s,
       toUInt32(max(toUnixTimestamp(start_time))) AS last_seen_epoch_s,
       argMin(trace_id, start_time)                AS example_trace_id
  FROM obstack.spans
 WHERE workspace_id = {workspace_id:String} AND status_code = 'error' AND trace_id != ''
   AND start_time >= fromUnixTimestamp64Milli({since_ms:Int64})
   AND start_time <  fromUnixTimestamp64Milli({until_ms:Int64})
 GROUP BY service, span_name
 ORDER BY first_seen_epoch_s, service, span_name
 LIMIT {fetch:UInt32}`;

/**
 * One `(service, span name)` group, in the SQL's own column names (the
 * `issues.ts:116-129` `IssueRow` idiom — this is the wire shape, and the mapping
 * into `IncidentTimelineEntry` belongs to the stitcher that owns the timeline's
 * vocabulary).
 *
 * The four numbers are declared `number` and that is PROVEN, not assumed: every
 * one is wrapped in `toUInt32`, which stays inside the JSON number range, so
 * `JSONEachRow` emits `"errors":4` and not `"errors":"4"`. The proof is in
 * `incident-errors.integration.test.ts`, which asserts these values through
 * `node:assert/strict` — where `equal(row.errors, 2)` fails a string `"2"`. If a
 * future engine starts quoting 32-bit integers, that file reds rather than the
 * timeline silently rendering `"2" + 1 === "21"` errors.
 */
export interface IncidentErrorRow {
  service: string;
  span_name: string;
  errors: number;
  /** Epoch SECONDS of the earliest error span in the group — where the entry is drawn (D532). */
  first_seen_epoch_s: number;
  /** Epoch SECONDS of the latest — the entry's `until`, its own grain. */
  last_seen_epoch_s: number;
  /** The trace of the EARLIEST span in the group (`argMin`), never `''`. */
  example_trace_id: string;
}

/**
 * The trace leg's read. `sinceMs`/`untilMs` are epoch MILLISECONDS of the half-open
 * window `[since, until)`, both sampled from the ONE clock the stitcher samples
 * once and binds to all three legs (D534) — nothing here reads a clock, and a
 * `now()` inside the SQL would be a second one.
 *
 * ---- `fetch`, and where the probe row is dropped: NOT here (D536) ----
 *
 * Every row the LIMIT returned comes back, in the SQL's own order. The caller
 * passes `fetch = TIMELINE_LEG_CAP + 1` and the extra row IS the truncation
 * signal, so this module must not eat it. Three reasons it belongs to the
 * caller and not here:
 *
 *  - This module is handed a NUMBER. It is told nothing about what that number
 *    means, so dropping the last row when `rows.length === fetch` would be this
 *    module asserting `fetch = cap + 1` — a convention it never received. A
 *    caller that genuinely wanted `fetch` rows would silently get `fetch - 1`.
 *  - Dropping here DESTROYS the only evidence of truncation unless a second
 *    return field re-encodes it. The module would then both hide a row and hand
 *    back a claim about the row it hid: two representations of one fact, held by
 *    the party least able to check them against each other.
 *  - D536's `omissions` is per-leg and locatable across THREE legs, two of them
 *    in Postgres. The probe convention has to have one definition or the three
 *    legs can disagree about what a full page means, and that definition lives
 *    where `TIMELINE_LEG_CAP` does.
 *
 * Handing the rows back undropped is also what makes D536's "the probe row gives
 * `omittedAfterIso` for free" true: the caller reads `rows.length > cap` for the
 * fact and `rows[cap - 1].first_seen_epoch_s` for the instant, both off this
 * array, with no second read and no second field.
 *
 * `fetch` is bound as `{fetch:UInt32}` and NOT clamped in TS. Measured against
 * the pinned engine: `-1` and `50.5` are both refused with `Code: 457 …
 * (BAD_QUERY_PARAMETER)` before a row is read, so a caller's arithmetic bug
 * surfaces as a failure rather than as a quietly wrong page. The one legal-but
 * -useless value is `0` (a legal `LIMIT 0`, zero rows — indistinguishable from a
 * quiet window), and `cap + 1` cannot produce it; a `Math.max(1, …)` clamp would
 * not fix that case either, it would only turn a caller's -1 cap into one row.
 */
export async function queryIncidentErrors(
  ch: ScopedClickHouse,
  args: { sinceMs: number; untilMs: number; fetch: number },
): Promise<IncidentErrorRow[]> {
  return ch.queryRows<IncidentErrorRow>(INCIDENT_ERRORS_SQL, {
    since_ms: args.sinceMs,
    until_ms: args.untilMs,
    fetch: args.fetch,
  });
}
