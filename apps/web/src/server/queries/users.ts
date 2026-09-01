import "server-only";
import {
  SLOW_NS,
  USERS_CAP,
  WINDOW_HOURS,
  type ImpactedUser,
  type ImpactedUsersResult,
  type UserRisk,
} from "@/lib/users-types";
import type { ScopedClickHouse } from "@/server/clickhouse";

/**
 * `listImpactedUsers` (D398, frozen). Identity is `attributes['enduser.id']`,
 * falling back to `attributes['user.id']` (current semconv) — both key
 * strings are SQL-TEXT LITERALS below, never a parameter or interpolation
 * (D11): there is no caller input anywhere in this statement that could name
 * a different key.
 *
 * The inner subquery restricts to ROOT spans (`parent_span_id = ''`) in the
 * last `WINDOW_HOURS` and computes `identity` once per row; the outer query
 * drops the empty-identity rows (no SDK-supplied id at all) and aggregates.
 * `slow` compares `duration_ns` against `SLOW_NS` (2s) — bound as a parameter
 * since it is a real value, unlike the fixed window (D394: no range argument,
 * the bound is a literal proven by seeding a row outside it, mutation-style,
 * in users.integration.test.ts).
 *
 * `argMaxIf`/`maxIf` return their type's default (empty string / epoch zero)
 * when NO row satisfies `status_code = 'error'` — that default is never
 * surfaced: `listImpactedUsers` below only builds `lastFailure` when
 * `failures > 0`, which is exactly when at least one row matched the same
 * condition these combinators use.
 *
 * `count() OVER ()` runs over every grouped row BEFORE `ORDER BY`/`LIMIT`
 * truncate to `USERS_CAP` (D402) — the pre-cap distinct-identity count the
 * banner needs, without a second scoped read.
 */
const SQL = `
SELECT
    identity,
    toString(count())                                          AS requests,
    toString(countIf(status_code = 'error'))                   AS failures,
    toString(countIf(duration_ns >= {slow_ns:UInt64}))         AS slow,
    argMaxIf(trace_id, start_time, status_code = 'error')       AS last_failure_trace_id,
    argMaxIf(name, start_time, status_code = 'error')           AS last_failure_name,
    formatDateTime(maxIf(start_time, status_code = 'error'), '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS last_failure_at,
    toString(count() OVER ())                                  AS total_users
FROM (
    SELECT
        trace_id, name, start_time, duration_ns, status_code,
        if(attributes['enduser.id'] != '', attributes['enduser.id'], attributes['user.id']) AS identity
    FROM obstack.spans
    WHERE workspace_id = {workspace_id:String}
      AND parent_span_id = ''
      AND start_time >= now() - INTERVAL ${WINDOW_HOURS} HOUR
)
WHERE identity != ''
GROUP BY identity
ORDER BY count() DESC, identity
LIMIT ${USERS_CAP}`;

interface Row {
  identity: string;
  requests: string;
  failures: string;
  slow: string;
  last_failure_trace_id: string;
  last_failure_name: string;
  last_failure_at: string;
  total_users: string;
}

/**
 * D398's risk order, evaluated top to bottom: at-risk wins over degraded even
 * when both would apply; a user with zero failures can still be degraded on
 * slowness alone. `requests === 0` cannot occur from a real GROUP BY row (a
 * group exists only because at least one span produced it) — handled here
 * only so the function stays total.
 */
export function riskFor(requests: number, failures: number, slow: number): UserRisk {
  if (requests === 0) return "healthy";
  const failureRate = failures / requests;
  if (failureRate >= 0.1) return "at-risk";
  if (failureRate >= 0.02 || slow / requests >= 0.2) return "degraded";
  return "healthy";
}

export async function listImpactedUsers(ch: ScopedClickHouse): Promise<ImpactedUsersResult> {
  const rows = await ch.queryRows<Row>(SQL, { slow_ns: SLOW_NS });
  const users: ImpactedUser[] = rows.map((row) => {
    const requests = Number(row.requests);
    const failures = Number(row.failures);
    const slow = Number(row.slow);
    return {
      userId: row.identity,
      requests,
      failures,
      slow,
      lastFailure:
        failures > 0
          ? { traceId: row.last_failure_trace_id, rootName: row.last_failure_name, at: row.last_failure_at }
          : null,
      risk: riskFor(requests, failures, slow),
    };
  });
  return { users, totalUsers: rows.length > 0 ? Number(rows[0].total_users) : 0 };
}
