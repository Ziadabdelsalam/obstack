import "server-only";
import type { QueryRows } from "@/server/postgres";

/**
 * THE Explain quota definition (D226). One module answers "how many Explain
 * runs has this workspace spent this month, out of how many", and everything
 * that shows or enforces that pair — the panel's counter line, the settings
 * meter, and the route that refuses an over-quota run — reads it from here.
 * The two numbers come from `plans.explain_quota` and `explain_runs`, so
 * neither 20 nor 200 is spelled in TypeScript (D163): the landing page's
 * promise became the catalog of record in `0006_explain_quota.sql`, and this
 * module is how the product reads it back.
 *
 * `queryRows` is INJECTED (the D113 pattern every sibling store keeps) rather
 * than imported, so nothing here finds a store ambient and the whole path is
 * provable against a real Postgres with no server in the process.
 */

/**
 * The month boundary, spelled ONCE for both statements below (D179's lesson
 * without D179's trap): `now() AT TIME ZONE 'UTC'` is the UTC wall clock, so
 * the month is UTC's rather than the session's, and `::date` makes it the DATE
 * `explain_runs.period_start` stores — a date has no instant to re-anchor, so
 * there is no timestamptz comparison here to get the zone wrong.
 */
const MONTH_START = `(date_trunc('month', now() AT TIME ZONE 'UTC'))::date`;

/**
 * The plan's quota and this month's spend, in one round trip.
 *
 * The plan resolution is the D163 join verbatim — `COALESCE(wp.plan_id,
 * 'free')` — so a workspace that has never touched billing is on free with no
 * row having to exist for it, and a workspace that has never run Explain has no
 * `explain_runs` row and reads zero used.
 */
const QUOTA_SQL = `
  SELECT p.explain_quota      AS quota,
         coalesce(r.used, 0)  AS used
    FROM (SELECT $1::text AS workspace_id) w
    LEFT JOIN workspace_plans wp ON wp.workspace_id = w.workspace_id
    JOIN plans p ON p.id = COALESCE(wp.plan_id, 'free')
    LEFT JOIN explain_runs r ON r.workspace_id = w.workspace_id
                            AND r.period_start = ${MONTH_START}`;

/**
 * Enforcement and increment as ONE statement (D225), which is the whole reason
 * this is not a read followed by a write: two runs that both read "19 used"
 * would both be allowed to spend the 20th. Postgres evaluates the conflicting
 * update under a row lock, so the second of two concurrent runs adds to the
 * value the first committed, and the `WHERE` is checked against that value.
 *
 * Zero rows returned means the guard refused: over quota, and nothing spent.
 * The `WHERE $2::int > 0` on the INSERT arm is the same refusal for the first
 * run of a month on a zero-quota plan, which the ON CONFLICT arm never sees.
 *
 * One statement means no read→write window, so no advisory lock and no
 * `TxQuery` (D198's brand names a lock scope; there is no lock here to scope).
 */
const SPEND_SQL = `
  INSERT INTO explain_runs (workspace_id, period_start, used)
       SELECT $1, ${MONTH_START}, 1
        WHERE $2::int > 0
  ON CONFLICT (workspace_id, period_start) DO UPDATE
          SET used = explain_runs.used + 1,
              updated_at = now()
        WHERE explain_runs.used < $2::int
    RETURNING used`;

/**
 * A workspace's Explain month: how many runs it has spent and how many its plan
 * includes. The pair travels together because the surfaces divide it — a reader
 * that fetched the quota from one place and the count from another is the
 * divergence D171 was written about.
 */
export interface ExplainQuota {
  quota: number;
  used: number;
}

/** The outcome of asking for a run: refused means `used` is unchanged. */
export interface ExplainRunOutcome extends ExplainQuota {
  allowed: boolean;
}

type QuotaRow = { quota: number; used: number };

/**
 * This month's Explain spend against this workspace's plan — the read the panel
 * counter and the settings meter share.
 *
 * Deliberately NOT wrapped in React's `cache` the way `getUsage` is (D183): the
 * route reads this and then spends a run in the same request, so a
 * request-scoped memo would hand the refusal message a count from before the
 * increment. The read is one indexed row and is not on any hot path.
 *
 * A catalog with no `free` row throws, loudly, for the reason `getUsage` gives:
 * `COALESCE(…, 'free')` naming a plan that does not exist is a broken
 * migration, not a workspace's state.
 */
export async function getExplainQuota(
  workspaceId: string,
  query: QueryRows,
): Promise<ExplainQuota> {
  const [row] = await query<QuotaRow>(QUOTA_SQL, [workspaceId]);
  if (!row) {
    throw new Error("the plans catalog has no 'free' row — 0005_metering.sql seeds it (D163)");
  }
  return { quota: row.quota, used: row.used };
}

/**
 * Spend one Explain run, or refuse because the plan's runs for this month are
 * gone. This is the enforcement — the route asks HERE and never compares two
 * numbers of its own (D226: one function, three consumers).
 *
 * The quota is read first and passed to the atomic statement as `$2` because a
 * plan's quota is what the catalog says at the moment of the run; the count it
 * is compared against is read and incremented inside the one statement, which
 * is the number two concurrent runs could race over. Refused runs return the
 * pair unchanged so the surface can state exactly what it refused against
 * ("20 of 20 used this month") rather than an error.
 *
 * Called BEFORE the provider (D225 order: config check, then this, then the
 * call), and there is no refund: a provider that fails after this returns is a
 * counted run. Refunding would need the read→write this statement exists to
 * avoid, and a failed run still cost us the tokens it got to.
 */
export async function spendExplainRun(
  workspaceId: string,
  query: QueryRows,
): Promise<ExplainRunOutcome> {
  const { quota, used } = await getExplainQuota(workspaceId, query);
  const [row] = await query<{ used: number }>(SPEND_SQL, [workspaceId, quota]);
  return row ? { allowed: true, quota, used: row.used } : { allowed: false, quota, used };
}
