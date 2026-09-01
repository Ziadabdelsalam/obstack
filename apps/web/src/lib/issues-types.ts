/**
 * The issues query contract (D399, location per D366).
 *
 * CLIENT-SAFE by design, like `metrics-types.ts`: `server/queries/issues.ts` is
 * `server-only` (it holds the SQL and a `ScopedClickHouse`), but the surface
 * rendering its rows still needs the shapes and the two window constants it
 * states in words. The only import here is a type, erased at build time.
 *
 * There is NO fingerprint helper in this file, deliberately (D399): the
 * fingerprint is computed only in SQL and arrives as an opaque string, so
 * there is no second implementation to drift from the first.
 */

import type { Layer } from "./types";

/**
 * The ONE window every S6.2 aggregate surface renders (D394) — no range
 * argument, no picker. `listIssues` bounds its scan with it and the surface
 * says "last 24h" in words; `spark` carries exactly this many hourly buckets.
 */
export const WINDOW_HOURS = 24;

/**
 * D50's recency anchor, the ONLY input to `status` (D361 — issues are
 * stateless here: nothing is assigned, muted or resolved by a human, so
 * "resolved" can only ever mean "stopped happening"). The legend on the
 * surface states this number.
 */
export const RECENT_HOURS = 6;

/**
 * `new` = every occurrence is inside the last 6h (it started just now);
 * `resolved` = no occurrence is inside the last 6h (it stopped);
 * `ongoing` = both older and recent occurrences.
 */
export type IssueStatus = "new" | "ongoing" | "resolved";

/** One group of error spans sharing a fingerprint, within the 24h window. */
export interface Issue {
  /** Opaque, stable, SQL-computed over (service, layer, span name, normalized message). */
  fingerprint: string;
  /** The normalized `status_message`, or the span name when the message is empty. */
  title: string;
  service: string;
  layer: Layer;
  /** Error spans in the window. */
  count: number;
  /** `WINDOW_HOURS` hourly buckets, oldest first; a 0 is a measured zero, not a gap. */
  spark: number[];
  /** ISO UTC minute, within the window ("first seen in this 24h window"). */
  firstSeenAt: string;
  /** ISO UTC minute. */
  lastSeenAt: string;
  status: IssueStatus;
  /** The most recent trace carrying this error. */
  exampleTraceId: string;
}

/** `total` is the PRE-cap distinct-issue count, for the D402 banner. */
export interface IssuesResult {
  issues: Issue[];
  total: number;
}
