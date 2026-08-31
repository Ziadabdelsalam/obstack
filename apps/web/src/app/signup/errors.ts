import { RateLimitedError } from "@/server/rate-limit";

/**
 * The closed vocabulary of `/signup?error=` (D121). The action emits a CODE and
 * this module owns the words; the query value itself never reaches the page, so
 * the parameter cannot carry text of a link author's choosing onto a screen a
 * stranger is about to type a password into.
 *
 * Same shape as the D65 URL-contract modules (`lib/logs-filter.ts`): one
 * definition of the vocabulary, shared by the writer and the reader.
 *
 * The two length numbers are better-auth 1.7.1's documented defaults (8 and
 * 128) and this config overrides neither — copy that named a number the server
 * does not enforce would be the same lie as the generic sentence these codes
 * replace (D129). They move only if `authConfig()` starts setting them.
 *
 * `rate_limited` is F1's addition (D339): the one member here that is not a
 * better-auth answer at all, but obstack's own limiter (`server/rate-limit.ts`)
 * refusing before better-auth is ever called.
 */
export const SIGNUP_ERRORS = {
  "missing-fields": "Name, email and password are all required.",
  exists: "That email already has an account — sign in instead.",
  "invalid-email": "That email address isn't valid. Use a full address like you@example.com.",
  "password-short": "That password is too short. Use at least 8 characters.",
  "password-long": "That password is too long. Use at most 128 characters.",
  rate_limited: "Too many attempts from this address. Try again later.",
  "signup-failed": "Signup failed. Nothing was created — please try again.",
} as const;

export type SignupErrorCode = keyof typeof SIGNUP_ERRORS;

/** What an unrecognised code gets — never the code itself. */
const GENERIC = SIGNUP_ERRORS["signup-failed"];

/**
 * D68 totality: `error` comes off the URL, so it may be absent, repeated (the
 * router hands an array), or any hostile string. Absent is no message at all;
 * anything present that is not a member of the vocabulary is the one generic
 * sentence.
 *
 * `Object.hasOwn` rather than `in` or a bare lookup: `?error=toString` walks the
 * prototype chain through either of those and comes back with a function — the
 * measured D68 failure shape, here it would render one.
 */
export function signupErrorMessage(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const code = Array.isArray(raw) ? raw[0] : raw;
  if (typeof code !== "string") return GENERIC;
  return Object.hasOwn(SIGNUP_ERRORS, code) ? SIGNUP_ERRORS[code as SignupErrorCode] : GENERIC;
}

/**
 * The other half of the same vocabulary: which of these codes a failed signup
 * IS. It lives here rather than beside the action for one reason — `actions.ts`
 * carries `"use server"` and may export nothing but async functions, so a pure
 * mapping trapped there cannot be tested at all (D133). Reading it next to the
 * words it selects is the bonus.
 *
 * better-auth's `APIError` carries a machine-readable `body.code`; that — not
 * its English message — is what this maps. Total by construction: anything
 * unrecognised is `signup-failed`, because a failure inside our own transaction
 * says nothing a stranger can act on. Deliberately pure, so the surface keeps
 * the logging and this keeps the property.
 */
export function signupErrorCode(error: unknown): SignupErrorCode {
  // D339: obstack's own refusal, thrown from `server/auth.ts` before
  // better-auth's `signUpEmail` is ever reached — checked first and by
  // `instanceof` because this class is never anything but our own throw.
  if (error instanceof RateLimitedError) return "rate_limited";

  const api = error as { name?: string; body?: { code?: string; message?: string } } | null;
  if (api?.name === "APIError") {
    switch (api.body?.code) {
      case "USER_ALREADY_EXISTS":
      case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
        return "exists";
      // Defense in depth, and shadowed today: signup's own body schema rejects a
      // bad address first (the VALIDATION_ERROR arm below), so at 1.7.1 nothing
      // reaches this. It stays because `INVALID_EMAIL` is the code the library
      // documents for exactly this failure and DOES raise on sign-in — reorder
      // those two checks upstream and the property survives silently instead of
      // regressing to the generic sentence. Its coverage is a direct unit
      // assertion (D133), so it no longer depends on being live-reachable.
      case "INVALID_EMAIL":
        return "invalid-email";
      case "PASSWORD_TOO_SHORT":
        return "password-short";
      case "PASSWORD_TOO_LONG":
        return "password-long";
      case "VALIDATION_ERROR":
        // Measured at 1.7.1: the signup route rejects a bad address in its body
        // schema BEFORE the `INVALID_EMAIL` path above can fire, and the only
        // thing that identifies the field is the message prefix — the error
        // body carries no field path. `me@localhost` is the case that matters:
        // `type="email"` accepts it and zod's `z.email()` does not, so without
        // this the browser says the field is fine and the page says "try
        // again" about a retry that can never work (D129). A validation error
        // we cannot attribute falls through to the generic sentence.
        if (api.body?.message?.startsWith("[body.email]")) return "invalid-email";
    }
  }
  return "signup-failed";
}
