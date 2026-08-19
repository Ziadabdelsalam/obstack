import "server-only";
import { dataMode } from "@/server/data";
import { queryRows, type QueryRows } from "@/server/postgres";
import { billingMode, getBilling } from "./client";
import type { BillingClient, UsageEvent } from "./types";

/**
 * Ledger → Polar (D170). Our Postgres `usage_ledger` is the count of record —
 * the same rows the billing tab shows and the banner raises from — and this is
 * the only thing that carries them to the billing rail. Polar never counts for
 * us and ingest never calls Polar (D110): usage flows one way, from one number,
 * so "what we billed" and "what we showed" cannot disagree.
 *
 * The whole design rests on one measured fact: Polar deduplicates server-side on
 * a caller-supplied `external_id` and reports how many it skipped. A
 * deterministic id per (workspace, hour window) therefore makes re-sending free,
 * and every piece of machinery a reporter usually needs disappears with it:
 *
 *  - no send-log and no watermark — each run re-sends the last 24 hours of
 *    closed windows unconditionally, so a run that died mid-flight, a deploy
 *    that skipped a tick, or a Polar outage all heal on the next tick with no
 *    state of ours to repair;
 *  - no leader election — N replicas sending the same 24 hours is N-1 duplicate
 *    counts and one insert, which is exactly what dedup is for (D170 REFUSES it
 *    as speculative).
 *
 * What we DO have to get right is which windows are final, and that is the rule
 * below.
 */

/** The ledger's bucket width — `period_start` is a UTC hour, truncated by the writer (D162). */
const WINDOW_MS = 60 * 60 * 1000;

/**
 * How long after an hour ends before we call it final. Ingest flushes on a 5s
 * tick and a late or retried flush can still land in a just-closed bucket, so
 * five minutes of settle is the margin between "the hour is over" and "every
 * writer has finished writing it".
 *
 * This is the load-bearing correctness rule of the module and the reason the
 * settle test exists: dedup makes the FIRST send of an external id final, so an
 * hour sent while it was still being written would freeze that undercount in
 * Polar forever — the correction can never be ingested, because it carries the
 * same id.
 */
const SETTLE_MS = 5 * 60 * 1000;

/** How far back each run re-sends. Long enough to cover an outage, cheap because it dedups. */
const RESEND_MS = 24 * 60 * 60 * 1000;

/** The interval `instrumentation.ts` runs this on — well under the 24h it re-sends. */
export const REPORTER_INTERVAL_MS = 5 * 60 * 1000;

/** The meter's name in Polar. One name for one thing: an ingested event (PRD §10). */
export const USAGE_EVENT_NAME = "ingest.events";

/**
 * Only workspaces with a `polar_customer_id` (D170) — the id is a receipt of a
 * real Polar customer, so its absence means "this workspace has never been
 * billed" and free-tier usage never leaves our ledger.
 *
 * The 24-hour floor is bound here because it bounds the SCAN; the settle margin
 * is applied in TypeScript, on purpose. The closed-window rule is the property
 * that must never quietly change, and a rule in the query is a rule only
 * Postgres can be asked about — in this file it is proven against the fake with
 * an open window in the result set that never becomes an event.
 *
 * D11 posture: read-only, every value `$`-bound.
 */
const LEDGER_SQL = `
  SELECT l.workspace_id, l.period_start, l.spans, l.logs
    FROM usage_ledger l
    JOIN workspace_plans p ON p.workspace_id = l.workspace_id
   WHERE p.polar_customer_id IS NOT NULL
     AND l.period_start >= $1
   ORDER BY l.workspace_id, l.period_start`;

/** `spans`/`logs` are BIGINT, and `pg` hands BIGINT back as a string — hence `Number` below. */
type LedgerRow = {
  workspace_id: string;
  period_start: Date;
  spans: string;
  logs: string;
};

/** What a run needs, injected — no ambient store and no ambient rail (the D113 pattern). */
export interface ReporterDeps {
  query: QueryRows;
  billing: BillingClient;
  /** The clock, so the closed-window rule is testable without waiting an hour. */
  now?: Date;
}

/** What a run did. `duplicates` is the interesting one: it is idempotency, observed. */
export interface ReporterRun {
  events: number;
  inserted: number;
  duplicates: number;
}

/**
 * The dedup key, and the only reason any of this is safe to repeat (D170).
 * `period_start` is already a UTC hour, so the RFC3339 rendering is stable
 * across runs, processes and replicas — two senders of the same window compute
 * the same string or the scheme is broken.
 */
const externalId = (workspaceId: string, periodStart: Date) =>
  `usage:${workspaceId}:${periodStart.toISOString()}`;

/**
 * One pass: read the closed windows, send them, answer with what Polar said.
 * Exported for the tests and for the drive — the interval below is the only
 * other caller, and it adds nothing but a clock.
 */
export async function runReporterOnce(deps: ReporterDeps): Promise<ReporterRun> {
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - RESEND_MS);
  const rows = await deps.query<LedgerRow>(LEDGER_SQL, [since]);

  const events: UsageEvent[] = [];
  for (const row of rows) {
    const windowEnd = new Date(row.period_start.getTime() + WINDOW_MS);
    // Closed means: the hour is over AND the settle margin has passed.
    if (windowEnd.getTime() + SETTLE_MS > now.getTime()) continue;

    const spans = Number(row.spans);
    const logs = Number(row.logs);
    events.push({
      externalCustomerId: row.workspace_id,
      externalId: externalId(row.workspace_id, row.period_start),
      name: USAGE_EVENT_NAME,
      // Backdated to the window it describes — Polar takes an explicit
      // timestamp precisely so replayed batches meter in their own period.
      timestamp: windowEnd,
      metadata: { spans, logs, events: spans + logs },
    });
  }

  if (events.length === 0) return { events: 0, inserted: 0, duplicates: 0 };
  const result = await deps.billing.ingestUsage(events);
  return { events: events.length, ...result };
}

/**
 * Start the interval, or decline to (D170). Both gates matter and neither is a
 * convenience: mock mode has no ledger to read, and `fake` mode has no Polar to
 * report to — so CI, a mock-mode deployment and a local `next dev` all run this
 * function and all start nothing. The sandbox rail is the only configuration
 * that meters.
 *
 * Returns the timer so a caller can prove which branch it took; the interval is
 * unref'd because a periodic report is not a reason for a process to stay
 * alive — the server's own listener decides that.
 */
export function startUsageReporter(): NodeJS.Timeout | undefined {
  if (dataMode !== "live" || billingMode() !== "polar-sandbox") return undefined;

  const timer = setInterval(() => {
    // A failed run is a logged line and nothing else: the next tick re-sends
    // the same 24 hours, so there is no recovery to perform and no reason for a
    // billing outage to take a request-serving process down with it. The
    // message carries no token — every secret this path touches lives inside
    // the client (D168).
    runReporterOnce({ query: queryRows, billing: getBilling() }).catch((error: unknown) => {
      console.error(
        `[billing] usage report failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, REPORTER_INTERVAL_MS);
  timer.unref();
  return timer;
}
