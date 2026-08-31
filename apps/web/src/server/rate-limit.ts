import "server-only";
import { headers } from "next/headers";

/**
 * obstack's own abuse control for `/signup` and `/login` (D339). It exists
 * because better-auth's built-in limiter never runs for either call: signup
 * and sign-in go through in-process `auth.api.signUpEmail` /
 * `auth.api.signInEmail` (`server/auth.ts`, `app/login/actions.ts`), and
 * better-auth's limiter is wired only into the HTTP router's `onRequest` —
 * the mounted `/api/auth/[...all]` handler that these two actions never call
 * (measured against the vendored 1.7.1 build: `dist/api/to-auth-endpoints.mjs`,
 * the in-process path, carries zero `rateLimit` references — S5 kickoff E1).
 *
 * An in-memory sliding window, keyed `(ip, action)`. This is correct for
 * exactly one replica. Railway's `web` service runs one replica at launch
 * (D334) — if that ever changes, each replica keeps its own map, so the
 * effective allowance multiplies by replica count. That consequence is a
 * fact about this mechanism, not a bug to route around here; a shared store
 * (Redis, Postgres) would be the fix, and is out of scope until multi-replica
 * web is a real plan.
 */

export type RateLimitAction = "signup" | "login";

type Policy = { max: number; windowMs: number };

const POLICIES: Record<RateLimitAction, Policy> = {
  signup: { max: 5, windowMs: 60 * 60 * 1000 },
  login: { max: 10, windowMs: 10 * 60 * 1000 },
};

const LONGEST_WINDOW_MS = Math.max(...Object.values(POLICIES).map((p) => p.windowMs));

let buckets = new Map<string, number[]>();

/** Fires once per process, never once per refused request — the K0 staging gate greps for this line. */
let warnedNoIp = false;

/** Deterministic tests need a clean slate and the warning re-armed between cases. */
export function resetRateLimitsForTests(): void {
  buckets = new Map();
  warnedNoIp = false;
}

/** Keeps the map from growing without bound: nothing older than the longest policy's window can matter to any future check. */
function sweep(now: number): void {
  const cutoff = now - LONGEST_WINDOW_MS;
  for (const [key, hits] of buckets) {
    const kept = hits.filter((t) => t > cutoff);
    if (kept.length === 0) buckets.delete(key);
    else buckets.set(key, kept);
  }
}

/**
 * `true` = allowed (and the attempt is now counted); `false` = refused. A
 * missing IP fails OPEN — D339's ruling — because refusing every request
 * behind a proxy that does not forward `x-forwarded-for` would be an outage,
 * not a mitigation. The one-time warning is the loud half of "fail open,
 * loud": it names the situation so staging log review (K0) catches a
 * misconfigured proxy before launch, without making every anonymous request
 * pay for a `console.warn` call.
 */
export function checkRateLimit(action: RateLimitAction, ip: string | null, now = Date.now()): boolean {
  if (ip === null) {
    if (!warnedNoIp) {
      warnedNoIp = true;
      console.warn(
        `[rate-limit] could not determine a client IP for the "${action}" action — allowing the request (fail-open by design, D339)`,
      );
    }
    return true;
  }

  sweep(now);

  const policy = POLICIES[action];
  const key = `${action}:${ip}`;
  const windowStart = now - policy.windowMs;
  const hits = (buckets.get(key) ?? []).filter((t) => t > windowStart);

  if (hits.length >= policy.max) {
    buckets.set(key, hits);
    return false;
  }

  hits.push(now);
  buckets.set(key, hits);
  return true;
}

/**
 * D339's refusal, named so each surface's `errors.ts` can select its own
 * copy ("Too many attempts...") instead of falling through to that surface's
 * generic member. The login seam never needs this class — it knows the
 * refusal at the call site and returns the vocabulary code directly — but
 * the signup seam throws across a module boundary it does not own
 * (`app/signup/actions.ts`'s existing catch), so the shape has to survive
 * that throw. `instanceof` is the check, not `.name` duck-typing, because
 * this class is ours end to end and nothing forges it from outside.
 */
export class RateLimitedError extends Error {
  constructor(action: RateLimitAction) {
    super(`too many ${action} attempts from this address`);
    this.name = "RateLimitedError";
  }
}

/**
 * D339's IP rule as signed (advisor condition F-T8a): the RIGHTMOST hop of
 * `x-forwarded-for`. Everything to the left is client-supplied — a forger
 * rotating the leftmost value would open a fresh bucket per request — while
 * the rightmost entry is the one the single trusted proxy in front of the
 * app (Railway's edge) writes, under both documented proxy behaviours
 * (append or replace). No header at all names no client → `null`.
 */
export function clientIpFromForwarded(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const hops = headerValue.split(",").map((h) => h.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1]! : null;
}

/**
 * The current request's `x-forwarded-for`, or `null` if there is no IP to
 * read — which includes the case this repo already measured for
 * `next/headers`'s cookie half (`auth.integration.test.ts`'s
 * `realSessionCookie` comment): a caller reached outside a Next request scope
 * at all, e.g. this repo's own integration tests calling `signUpWithWorkspace`
 * directly with no request behind it. `headers()` throws there
 * ("`headers` was called outside a request scope" — measured against the
 * installed `next` build, `server/request/headers.js`); that is not a
 * different situation from "no IP present", it is the same one, so it folds
 * into the identical fail-open path rather than becoming a second error shape
 * the caller has to also handle.
 */
export async function getClientIp(): Promise<string | null> {
  try {
    return clientIpFromForwarded((await headers()).get("x-forwarded-for"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("was called outside a request scope")) {
      return null;
    }
    throw error;
  }
}
