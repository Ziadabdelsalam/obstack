import assert from "node:assert/strict";
import test from "node:test";
import {
  RateLimitedError,
  checkRateLimit,
  firstForwardedIp,
  resetRateLimitsForTests,
} from "./rate-limit";
import { signupErrorCode } from "@/app/signup/errors";

// run with: npm test --workspace apps/web
//
// D339: obstack's own limiter, because better-auth's never runs for these
// calls (E1 — signup/login are in-process `auth.api.*`, not the HTTP router
// `onRequest` reaches). In-memory sliding window keyed (ip, action); signup
// 5/IP/1h, login 10/IP/10min; a missing IP fails OPEN, loudly.
//
// Every test drives its own fake clock through `now` rather than the real one
// — the window-expiry case would otherwise need a real hour to elapse.

test.beforeEach(() => resetRateLimitsForTests());

test("the 6th signup from IP A inside the window is refused, IP B is untouched by A's exhaustion", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) {
    assert.equal(checkRateLimit("signup", "1.1.1.1", t0 + i), true, `signup ${i + 1} from A`);
  }
  assert.equal(checkRateLimit("signup", "1.1.1.1", t0 + 5), false, "6th signup from A");

  // B is the 6th signup call made in this test overall, and it succeeds — the
  // key is (ip, action), so A's 5-per-hour exhaustion carries no weight
  // against a different IP's own, still-empty bucket.
  assert.equal(checkRateLimit("signup", "2.2.2.2", t0 + 5), true, "B's own signup, unaffected by A");

  // ...and B's budget is enforced independently too, symmetrically with A's.
  for (let i = 1; i < 5; i++) checkRateLimit("signup", "2.2.2.2", t0 + 5 + i);
  assert.equal(checkRateLimit("signup", "2.2.2.2", t0 + 10), false, "6th signup from B, on its own budget");
});

test("the 11th login from A within 10 minutes is refused", () => {
  const t0 = 2_000_000;
  for (let i = 0; i < 10; i++) {
    assert.equal(checkRateLimit("login", "1.1.1.1", t0 + i), true, `login ${i + 1} from A`);
  }
  assert.equal(checkRateLimit("login", "1.1.1.1", t0 + 10), false, "11th login from A");
});

test("A's signup is allowed again after the window elapses", () => {
  const t0 = 3_000_000;
  for (let i = 0; i < 5; i++) checkRateLimit("signup", "1.1.1.1", t0 + i);
  assert.equal(checkRateLimit("signup", "1.1.1.1", t0 + 5), false, "still inside the window");

  const HOUR = 60 * 60 * 1000;
  assert.equal(
    checkRateLimit("signup", "1.1.1.1", t0 + HOUR + 1),
    true,
    "the window has fully elapsed — the same IP gets a fresh allowance",
  );
});

// signup and login are counted separately per D339's (ip, action) key — an IP
// that exhausts one policy must not be refused by the other.
test("signup and login windows are independent per IP", () => {
  const t0 = 4_000_000;
  for (let i = 0; i < 5; i++) checkRateLimit("signup", "1.1.1.1", t0 + i);
  assert.equal(checkRateLimit("signup", "1.1.1.1", t0 + 5), false, "signup exhausted");
  assert.equal(checkRateLimit("login", "1.1.1.1", t0 + 5), true, "login is a different bucket");
});

test("no IP present: fail open, and the warning fires exactly once across two calls", () => {
  const seen: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => void seen.push(args);
  try {
    assert.equal(checkRateLimit("signup", null, 5_000_000), true, "no IP must never refuse");
    assert.equal(checkRateLimit("signup", null, 5_000_001), true, "still allowed on the second call");
  } finally {
    console.warn = originalWarn;
  }

  const warnings = seen.filter((args) =>
    args.some((a) => typeof a === "string" && a.includes("could not determine a client IP")),
  );
  assert.equal(warnings.length, 1, "the no-IP warning must fire exactly once per process, not per call");
});

// ---- firstForwardedIp: D339's IP extraction rule ----

test("firstForwardedIp reads the FIRST hop of x-forwarded-for", () => {
  assert.equal(firstForwardedIp("203.0.113.7, 10.0.0.1, 10.0.0.2"), "203.0.113.7");
  assert.equal(firstForwardedIp("203.0.113.7"), "203.0.113.7");
  assert.equal(firstForwardedIp("  203.0.113.7  ,10.0.0.1"), "203.0.113.7");
});

test("firstForwardedIp answers null for anything that names no client", () => {
  assert.equal(firstForwardedIp(null), null);
  assert.equal(firstForwardedIp(""), null);
  assert.equal(firstForwardedIp(","), null);
});

// ---- F1: the seam this module cannot exercise directly, proven at its boundary ----
//
// `assertNotRateLimited` in `server/auth.ts` lives inside a real Next request
// (it calls `getClientIp`, which needs `headers()`), and this repo has no
// request-scope shim for `next/headers` — both existing integration test
// files route around the same limitation for `nextCookies()` rather than
// simulate one (`auth.integration.test.ts`'s `realSessionCookie` comment,
// `invites.integration.test.ts:128`). So this proves the two halves of that
// seam directly instead: `checkRateLimit` really refuses the 6th signup from
// one IP (below the point auth.ts's `assertNotRateLimited` would throw), and
// the exact error it throws there (`RateLimitedError`) really surfaces as
// `signup/errors.ts`'s `rate_limited` member rather than the generic one —
// which is the whole of what `assertNotRateLimited` does between those two
// calls.
test("F1: the 6th signup from one IP is refused, and that refusal surfaces as rate_limited, not signup-failed", () => {
  const t0 = 6_000_000;
  const ip = "9.9.9.9";
  for (let i = 0; i < 5; i++) assert.equal(checkRateLimit("signup", ip, t0 + i), true, `signup ${i + 1}`);

  // this is exactly the boundary `assertNotRateLimited` checks in auth.ts
  assert.equal(checkRateLimit("signup", ip, t0 + 5), false, "6th signup from the same IP");

  // ...and exactly the error it throws when that boundary refuses, mapped by
  // the surface that owns the copy — not the generic fallback every other
  // failure inside the signup boundary lands on.
  assert.equal(signupErrorCode(new RateLimitedError("signup")), "rate_limited");
});
