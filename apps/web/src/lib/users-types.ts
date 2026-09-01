/**
 * The frozen users query-API contract (D398, location per D366).
 *
 * These types are CLIENT-SAFE by design: `server/queries/users.ts` is
 * `server-only` (it holds real SQL and a `ScopedClickHouse`), but
 * `UsersLive.tsx` still needs the shapes it returns to type its props — a
 * client-boundary-adjacent component cannot import a `server-only` module for
 * a type alone (S1.5/D10 precedent, `lib/metrics-types.ts` idiom). This file
 * carries no imports and two plain data constants, so it can be pulled into
 * either side of the server/client boundary.
 */

/** D394: every aggregate surface renders ONE fixed window, stated in words on the surface ("last 24h"). */
export const WINDOW_HOURS = 24;

/** D398: "slow" = root span duration at or above this many nanoseconds (2s). The surface states "slow = ≥2s". */
export const SLOW_NS = 2_000_000_000;

/** D402: cap, ranked by requests — "showing 50 of N users by requests". */
export const USERS_CAP = 50;

/**
 * D398's risk order (evaluated top to bottom): at-risk if failures/requests
 * is at least 10%; else degraded if failures/requests is at least 2% OR
 * slow/requests is at least 20%; else healthy. The rule is printed on the
 * surface, not just implemented.
 */
export type UserRisk = "at-risk" | "degraded" | "healthy";

/** One impacted user, over ROOT spans only, in the last `WINDOW_HOURS`. ABSENT: `org`, `plan` (fixture-only, D13). */
export interface ImpactedUser {
  /** `attributes['enduser.id']`, else `attributes['user.id']` (current semconv). */
  userId: string;
  requests: number;
  failures: number;
  slow: number;
  /** The most recent failing root span, or `null` when this user has none. */
  lastFailure: { traceId: string; rootName: string; at: string } | null;
  risk: UserRisk;
}

/** `totalUsers` is the PRE-cap distinct-identity count — the D402 banner needs the true N, not `users.length` (capped at `USERS_CAP`). */
export interface ImpactedUsersResult {
  users: ImpactedUser[];
  totalUsers: number;
}
