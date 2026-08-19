import "server-only";
import { cache } from "react";
import type { QueryRows } from "@/server/postgres";

/**
 * THE usage definition (D171). One function answers "how much of its plan has
 * this workspace spent this month", and everything that shows that number — the
 * Billing & usage tab, the shell's `UsageBanner` through the app layout, and the
 * e2e drive's banner-equals-tab assertion — reads it from here. Two readers with
 * two SUMs is the S2.3 L3 divergence class, and this module exists so that it
 * cannot happen: there is one statement, and it is below.
 *
 * The ledger is authoritative (D110). Polar is the billing rail and is not
 * consulted here, by anything, ever — usage flows OUT of these rows to Polar
 * through the reporter, never back in. Nothing on this path is a hot path: the
 * ingest service meters into `usage_ledger` in Go and never reads this module.
 *
 * Read-only and `$`-bound (D11): the two statements are SELECTs, the workspace
 * is a parameter and never interpolated, and `queryRows` is INJECTED rather than
 * imported (the D113 pattern every sibling store keeps) so a caller is handed
 * its store instead of finding one ambient.
 */

/**
 * What a workspace's month looks like. `eventQuota` and `eventsUsed` are the
 * pair the meter and the banner both divide, and they are the same pair because
 * they arrive together from one row.
 *
 * `asOf` is NULLABLE and that is the honest answer, not a missing value: a
 * workspace that has never had an accepted event has no ledger row, so there is
 * no moment to state. The surface says "no events yet" rather than dating the
 * epoch. When it is present it is the freshest `usage_ledger.updated_at` in the
 * window — how stale the displayed number is, bounded by the ingest flush
 * interval (D166), and the "as of …" the product prints.
 */
export interface WorkspaceUsage {
  planId: string;
  planName: string;
  eventQuota: number;
  eventsUsed: number;
  retentionDays: number;
  /** Start of the billing period: the calendar month, UTC (D163). */
  periodStart: Date;
  asOf: Date | null;
}

/** A row of the catalog, as the billing surface offers it. */
export interface Plan {
  id: string;
  name: string;
  eventQuota: number;
  retentionDays: number;
  priceUsdMonth: number;
}

/**
 * The D163 definition, verbatim and in one place.
 *
 *  - the plan is `JOIN plans p ON p.id = COALESCE(wp.plan_id, 'free')`, so a
 *    workspace with no `workspace_plans` row is on free WITHOUT a row having to
 *    be written for it — no signup change, no backfill;
 *  - the window is the calendar month, UTC;
 *  - usage is `SUM(spans + logs)`, one span or one log record being one event
 *    (PRD §10).
 *
 * The month boundary is spelled `date_trunc('month', now() AT TIME ZONE 'UTC')
 * AT TIME ZONE 'UTC'` in BOTH places it appears (D179), and the second `AT TIME
 * ZONE` is the load-bearing one: `date_trunc` there returns a naked `timestamp`,
 * and comparing a `timestamptz` column against a naked `timestamp` anchors it in
 * the SESSION's TimeZone. Ours happens to be UTC today, which is exactly why the
 * bug would be silent — a server started in another zone would cut the billing
 * month hours off, an hour of usage would land in the wrong invoice, and nothing
 * would say so. The re-anchor also fixes what the projection sends: a naked
 * `timestamp` crossing the wire is read back as a local-time `Date` and printed
 * an offset away from the month it names. Go's over-quota SELECT (D164) carries
 * the identical expression, so both runtimes cut the month at the same instant.
 *
 * The LATERAL keeps this to ONE round trip and one row: without it the plan read
 * and the sum would be two statements, and two statements are two clocks — the
 * `now()` in the window and the `now()` the period is reported as could land on
 * opposite sides of a month boundary once a month.
 */
const USAGE_SQL = `
  SELECT p.id             AS plan_id,
         p.name           AS plan_name,
         p.event_quota    AS event_quota,
         p.retention_days AS retention_days,
         date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS period_start,
         coalesce(l.events, 0) AS events_used,
         l.as_of          AS as_of
    FROM (SELECT $1::text AS workspace_id) w
    LEFT JOIN workspace_plans wp ON wp.workspace_id = w.workspace_id
    JOIN plans p ON p.id = COALESCE(wp.plan_id, 'free')
    LEFT JOIN LATERAL (
           SELECT sum(spans + logs) AS events,
                  max(updated_at)   AS as_of
             FROM usage_ledger
            WHERE workspace_id = w.workspace_id
              AND period_start >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
         ) l ON true`;

/** The catalog, cheapest first — five rows at most, and the ONE place plans are defined (D163). */
const PLANS_SQL = `
  SELECT id, name, event_quota, retention_days, price_usd_month
    FROM plans
   ORDER BY price_usd_month, id`;

/**
 * `pg` hands back `bigint` and `numeric` as STRINGS, because either can exceed
 * what a double represents exactly. Ours cannot — a quota is millions and a
 * price is two figures — so the conversion is safe here and stated here rather
 * than repeated at every call site as a silent `Number(...)`.
 */
const toCount = (raw: string | number): number => Number(raw);

type UsageRow = {
  plan_id: string;
  plan_name: string;
  event_quota: string;
  retention_days: number;
  period_start: Date;
  events_used: string;
  as_of: Date | null;
};

type PlanRow = {
  id: string;
  name: string;
  event_quota: string;
  retention_days: number;
  price_usd_month: string;
};

/**
 * This month's usage against this workspace's plan.
 *
 * Always answers: a workspace with no plan row, no ledger row and no events is
 * on free with zero used, which is the true state of every workspace on the day
 * it is created — an empty result would make the tab and the banner invent a
 * fallback each, and the two fallbacks would be the divergence this module
 * exists to prevent. The one thing that CANNOT be answered is a catalog missing
 * its free row, and that throws, loudly: `COALESCE(…, 'free')` naming a plan
 * that does not exist is a broken migration, not a workspace's state.
 *
 * Wrapped in React's `cache` (D183), which is REQUEST-scoped memoisation and not
 * a cache in the stale-data sense: two callers in one render — the app layout's
 * banner and the settings page's meter — get one SUM over the ledger instead of
 * two, and the next request reads the ledger again ("`React.cache` is scoped to
 * the current request only", `next/dist/docs/01-app/01-getting-started/
 * 06-fetching-data.md`). That is what makes "the banner number IS the tab
 * number" a property of the code rather than of two queries agreeing: inside one
 * request they are literally the same object. Both arguments are part of the
 * key, so a second workspace or a different injected read path is a second call.
 */
export const getUsage = cache(
  async (workspaceId: string, query: QueryRows): Promise<WorkspaceUsage> => {
    const [row] = await query<UsageRow>(USAGE_SQL, [workspaceId]);
    if (!row) {
      throw new Error("the plans catalog has no 'free' row — 0005_metering.sql seeds it (D163)");
    }
    return {
      planId: row.plan_id,
      planName: row.plan_name,
      eventQuota: toCount(row.event_quota),
      eventsUsed: toCount(row.events_used),
      retentionDays: row.retention_days,
      periodStart: row.period_start,
      asOf: row.as_of,
    };
  },
);

/**
 * Every plan we sell, read from the catalog rather than restated in TypeScript.
 * The billing surface shows what a plan costs and includes from these rows, and
 * `billing-actions.ts` validates a requested plan by finding it in the same
 * table — so "what plans exist" has one answer that both languages read (D163).
 */
export async function listPlans(query: QueryRows): Promise<Plan[]> {
  const rows = await query<PlanRow>(PLANS_SQL, []);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    eventQuota: toCount(row.event_quota),
    retentionDays: row.retention_days,
    priceUsdMonth: toCount(row.price_usd_month),
  }));
}
