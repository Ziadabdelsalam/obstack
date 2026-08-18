/**
 * The closed vocabulary of `/login?error=` (D121) — the signup vocabulary's
 * counterpart, kept separate because the two surfaces fail at different things
 * and neither should be able to render the other's copy.
 *
 * `invalid-credentials` covers both "no such user" and "wrong password":
 * better-auth answers `INVALID_EMAIL_OR_PASSWORD` for both (measured), and
 * splitting them here would turn this form into an account-enumeration oracle.
 *
 * `invalid-email` is NOT that: it is a malformed address, which the server
 * refuses before it can look anyone up (`INVALID_EMAIL`, measured — this is the
 * surface where 1.7.1 actually raises that code). It reveals nothing about who
 * has an account, and without it the page would answer "try again" to a retry
 * that can never succeed (D129).
 */
export const LOGIN_ERRORS = {
  "missing-fields": "Email and password are both required.",
  "invalid-email": "That email address isn't valid. Use a full address like you@example.com.",
  "invalid-credentials": "Invalid email or password.",
  "login-failed": "Sign-in failed. Please try again.",
} as const;

export type LoginErrorCode = keyof typeof LOGIN_ERRORS;

/** What an unrecognised code gets — never the code itself. */
const GENERIC = LOGIN_ERRORS["login-failed"];

/** D68 totality, same contract as `signupErrorMessage`: absent → nothing, unknown → the generic sentence. */
export function loginErrorMessage(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const code = Array.isArray(raw) ? raw[0] : raw;
  if (typeof code !== "string") return GENERIC;
  return Object.hasOwn(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code as LoginErrorCode] : GENERIC;
}

/**
 * Which of these codes a failed sign-in IS — `signupErrorCode`'s counterpart,
 * here for the same reason (D133): `actions.ts` is a `"use server"` module and
 * may export nothing but async functions, so a mapping left there is untestable.
 * Total by construction, and pure: the surface does the logging.
 */
export function loginErrorCode(error: unknown): LoginErrorCode {
  const api = error as { name?: string; body?: { code?: string } } | null;
  if (api?.name === "APIError") {
    switch (api.body?.code) {
      case "INVALID_EMAIL_OR_PASSWORD":
        return "invalid-credentials";
      // Measured at 1.7.1: sign-in — not signup — is where a malformed address
      // raises `INVALID_EMAIL`. Signup rejects the same input a step earlier in
      // its body schema, so the two surfaces reach the one code from different
      // errors (D129).
      case "INVALID_EMAIL":
        return "invalid-email";
    }
  }
  return "login-failed";
}
