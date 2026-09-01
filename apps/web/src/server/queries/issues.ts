import "server-only";
import { RECENT_HOURS, WINDOW_HOURS, type IssueStatus, type IssuesResult } from "@/lib/issues-types";
import type { Layer } from "@/lib/types";
import type { ScopedClickHouse } from "@/server/clickhouse";

/** D402: the surface states "showing top 50 of N" whenever `total` exceeds this. */
export const ISSUE_CAP = 50;

const HOUR_SECONDS = 3600;

/**
 * The error-message normalizer (D399), a chain of `replaceRegexpAll` over
 * `status_message` and the ONLY place grouping is decided. Two error spans
 * that differ only in the things collapsed here land in one issue; anything
 * left standing — a service, a layer, a span name, or one remaining word —
 * keeps them apart.
 *
 * Order is load-bearing, innermost first:
 *   1. quoted strings ('…' and "…") -> `<str>`, run FIRST so an id or a
 *      number quoted inside a message is erased with the quote rather than
 *      leaving a half-normalized fragment behind;
 *   2. dashed UUIDs, before the bare-hex rule: the bare rule's 8-char minimum
 *      would eat a UUID's first and last groups and leave its three 4-char
 *      groups to the digit rule, which is exactly how two UUIDs would fail to
 *      merge;
 *   3. hex runs of 8+ (trace/span/request ids, short object hashes);
 *   4. digit runs, last, so it only sees what the id rules left. This is also
 *      what collapses a numeric URL path segment (`/orders/9912` and
 *      `/orders/7` both become `/orders/<num>`) — a separate path rule would
 *      match the same characters twice and could only disagree.
 *
 * Rules 2-4 all emit the SAME `<num>` placeholder, and that is the whole point:
 * every id-shaped run is 8+ hex characters, so a DIFFERENT token per rule would
 * put `order 12345678` (8 digits, matched by the hex rule) and `order 1234567`
 * (7 digits, matched by the digit rule) in two different issues — two messages
 * differing only in digits, which D399 says must group. Any threshold that
 * decides between two placeholders splits a group the moment a value crosses
 * it; one placeholder cannot. The 8-char minimum still bounds rule 3 itself, so
 * a shorter hex-letter run is left standing as a word — the one boundary a
 * regex normalizer cannot avoid without eating ordinary English.
 *
 * `\\b` (a literal backslash-b reaching RE2) is written `\\\\b` here because a
 * ClickHouse string literal reads `\b` as a backspace character.
 */
const NORMALIZED_MESSAGE = `
        replaceRegexpAll(
            replaceRegexpAll(
                replaceRegexpAll(
                    replaceRegexpAll(status_message, '''[^'']*''|"[^"]*"', '<str>'),
                    '\\\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\\\b', '<num>'),
                '\\\\b[0-9a-fA-F]{8,}\\\\b', '<num>'),
            '[0-9]+', '<num>')`;

/**
 * One read, two levels (the `metrics.ts` shape). The inner query scans error
 * spans in the window once and groups them by the fingerprint's four inputs
 * PLUS the hour bucket, so the sparkline and the counts come from the same
 * pass; the outer query folds the buckets into one row per issue.
 *
 * Grouping is by the four inputs themselves, not by the hash: the fingerprint
 * is the stable id the UI carries, and deriving it from the group key rather
 * than grouping by it means a hash collision could never silently merge two
 * different errors into one row.
 *
 * `bucket` is an index, not a wall-clock hour: `(start_time - since) / 3600`,
 * with `since` computed once in TS and bound as a parameter, so every one of
 * the 24 slots is exactly an hour wide and every row inside the window lands
 * in one of them — the sparkline sums to `count` by construction. `least(…,
 * 23)` only catches a span timestamped in the future (clock skew), which
 * belongs in the newest bucket rather than dropped.
 *
 * `total_issues` is `count() OVER ()`, evaluated after the GROUP BY and before
 * the LIMIT (measured against the pinned engine): the true distinct-issue
 * count in the same pass that returns the capped rows, per D402.
 *
 * The `first_seen_epoch_s`/`last_seen_epoch_s` aliases deliberately differ
 * from the inner `first_seen_s`/`last_seen_s` they aggregate: reusing the name
 * trips the same `ILLEGAL_AGGREGATION` ("aggregate function max(last_seen_s)
 * is found inside another aggregate function") that `metrics.ts` documents,
 * raised here by the `argMax(example_trace_id, last_seen_s)` beside it.
 */
const ISSUES_SQL = `
SELECT
    lower(hex(cityHash64(service, layer_name, name, normalized)))  AS fingerprint,
    service                                                        AS service,
    layer_name                                                     AS layer,
    name                                                           AS span_name,
    normalized                                                     AS normalized,
    toUInt32(sum(c))                                               AS occurrences,
    groupArray(bucket)                                             AS spark_buckets,
    groupArray(c)                                                  AS spark_counts,
    toUInt32(min(first_seen_s))                                    AS first_seen_epoch_s,
    toUInt32(max(last_seen_s))                                     AS last_seen_epoch_s,
    argMax(example_trace_id, last_seen_s)                          AS example_trace_id,
    toUInt32(count() OVER ())                                      AS total_issues
FROM (
    SELECT
        service,
        toString(layer)                                            AS layer_name,
        name,${NORMALIZED_MESSAGE}                                 AS normalized,
        toUInt8(least(intDiv(toUInt32(toUnixTimestamp(start_time)) - {since_s:UInt32}, 3600), 23)) AS bucket,
        toUInt32(count())                                          AS c,
        toUInt32(min(toUnixTimestamp(start_time)))                 AS first_seen_s,
        toUInt32(max(toUnixTimestamp(start_time)))                 AS last_seen_s,
        argMax(trace_id, start_time)                               AS example_trace_id
    FROM obstack.spans
    WHERE workspace_id = {workspace_id:String}
      AND status_code = 'error'
      AND start_time >= fromUnixTimestamp({since_s:UInt32})
    GROUP BY service, layer_name, name, normalized, bucket
)
GROUP BY service, layer_name, name, normalized
ORDER BY occurrences DESC, fingerprint
LIMIT {cap:UInt32}`;

interface IssueRow {
  fingerprint: string;
  service: string;
  layer: Layer;
  span_name: string;
  normalized: string;
  occurrences: number;
  spark_buckets: number[];
  spark_counts: number[];
  first_seen_epoch_s: number;
  last_seen_epoch_s: number;
  example_trace_id: string;
  total_issues: number;
}

/** `"YYYY-MM-DDTHH:MMZ"` — the ISO UTC minute every live surface renders instants as. */
function isoMinute(epochSeconds: number): string {
  return `${new Date(epochSeconds * 1000).toISOString().slice(0, 16)}Z`;
}

/**
 * D399/D361: recency is the whole rule. Nothing here reads a human's verdict,
 * because this build stores none — an issue is "resolved" when it stopped
 * happening, and it can go back to "ongoing" on its own if it starts again.
 */
function statusOf(firstSeenS: number, lastSeenS: number, recentSinceS: number): IssueStatus {
  if (firstSeenS >= recentSinceS) return "new";
  if (lastSeenS < recentSinceS) return "resolved";
  return "ongoing";
}

/** The 24 hourly slots, oldest first; a bucket with no error spans is a measured 0. */
function sparkOf(buckets: number[], counts: number[]): number[] {
  const spark = new Array<number>(WINDOW_HOURS).fill(0);
  buckets.forEach((bucket, i) => {
    spark[bucket] += Number(counts[i]);
  });
  return spark;
}

/**
 * `listIssues` (D399). Error spans only — `status_code = 'error'` on
 * `obstack.spans`, with logs out of v1 — grouped by the SQL-computed
 * fingerprint over the last `WINDOW_HOURS`, capped at `ISSUE_CAP` by
 * occurrence count with the true total beside it (D402).
 *
 * There is no range argument (D394): the window is the contract. `since_s` is
 * anchored once here so the scan bound, the 24 sparkline slots and the status
 * cut all measure from the same instant — a second `now()` inside the SQL
 * could fall a bucket away from this one.
 */
export async function listIssues(ch: ScopedClickHouse): Promise<IssuesResult> {
  const nowS = Math.floor(Date.now() / 1000);
  const sinceS = nowS - WINDOW_HOURS * HOUR_SECONDS;
  const recentSinceS = nowS - RECENT_HOURS * HOUR_SECONDS;

  const rows = await ch.queryRows<IssueRow>(ISSUES_SQL, { since_s: sinceS, cap: ISSUE_CAP });

  return {
    issues: rows.map((row) => ({
      fingerprint: row.fingerprint,
      // D399: the normalized message names the issue; a span that errored with
      // no message at all is named by the span instead of by an empty line.
      title: row.normalized === "" ? row.span_name : row.normalized,
      service: row.service,
      layer: row.layer,
      count: Number(row.occurrences),
      spark: sparkOf(row.spark_buckets, row.spark_counts),
      firstSeenAt: isoMinute(row.first_seen_epoch_s),
      lastSeenAt: isoMinute(row.last_seen_epoch_s),
      status: statusOf(row.first_seen_epoch_s, row.last_seen_epoch_s, recentSinceS),
      exampleTraceId: row.example_trace_id,
    })),
    total: rows.length > 0 ? Number(rows[0].total_issues) : 0,
  };
}
