import {
  AVATAR_MAX_BYTES,
  NAME_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
  type AccountFeedback,
  type AccountSection,
} from "@/lib/account-types";

/**
 * The two closed vocabularies of `/app/account` (D712, the D121/D127/D129
 * shape `signup/errors.ts` fixed): `?error=` for what did not happen and
 * `?saved=` for what did. The actions emit a CODE and this module owns the
 * words; a caller's value never becomes a sentence, so nothing a link author
 * writes reaches a signed-in person's account page.
 *
 * ONE page, two vocabularies, one place both are read — and each code lands in
 * the SECTION it is about rather than at the top of a page whose password form
 * is at the bottom. The section is derived from the code's prefix by
 * `sectionOf` below, never carried in the URL: `?error=password-short` says
 * "password" because that is the first word of a member of a closed set, not
 * because a second parameter said so.
 *
 * Every sentence names what the reader can do about it (D129). The two length
 * numbers are the library's documented defaults, stated through the constants
 * `lib/account-types.ts` holds so this copy and the server agree by
 * construction; `server/account.test.ts` asserts they also agree with the
 * signup vocabulary's prose.
 *
 * The two `*-rate-limited` members are set by the action at the call site
 * (the login precedent, D339): obstack's own limiter refuses BEFORE
 * better-auth is called, so `accountErrorCode` gains no arm for them.
 */
export const ACCOUNT_ERRORS = {
  "name-invalid": `Give yourself a name — 1 to ${NAME_MAX} characters, on one line.`,
  "email-missing": "Enter the email address you want to sign in with.",
  "email-invalid": "That email address isn't valid. Use a full address like you@example.com.",
  "email-same": "That's already the address on this account.",
  "email-taken": "That email already has an account. Sign in with it, or choose another address.",
  "email-rate-limited": "Too many email changes for this account. Try again later.",
  "password-missing": "Enter your current password, and the new one twice.",
  "password-mismatch": "The two new passwords don't match. Type the new one twice, the same way.",
  "password-unchanged": "The new password is the same as the current one. Choose a different one.",
  "password-incorrect": "That isn't your current password. Nothing was changed.",
  "password-short": `That password is too short. Use at least ${PASSWORD_MIN} characters.`,
  "password-long": `That password is too long. Use at most ${PASSWORD_MAX} characters.`,
  "password-rate-limited": "Too many password attempts for this account. Try again later.",
  "session-not-found":
    "That session isn't one of this account's, or it has already ended. Reload the page to see the current list.",
  "avatar-missing": "Choose a picture to upload — a PNG, JPEG or WebP.",
  "avatar-too-large": `That picture is too large. Use one under ${Math.floor(AVATAR_MAX_BYTES / 1024)} KB.`,
  "avatar-not-image": "That file isn't a PNG, JPEG or WebP image.",
  "account-failed": "That didn't work. Please try again.",
} as const;

export type AccountErrorCode = keyof typeof ACCOUNT_ERRORS;

/**
 * What the page says when something DID happen. Present tense, one fact each
 * (D140): the row is already what the sentence says by the time the fresh GET
 * that renders it runs, because every action redirects (POST-redirect-GET,
 * D189's shape) rather than rendering its own result.
 */
export const ACCOUNT_NOTICES = {
  name: "Your name is updated.",
  email: "Your email address is updated. Sign in with it from now on.",
  password: "Your password is changed.",
  "password-sessions": "Your password is changed, and every other session is signed out.",
  session: "That session is signed out.",
  sessions: "Every other session is signed out.",
  avatar: "Your picture is updated.",
  "avatar-removed": "Your picture is removed. Your initials show instead.",
} as const;

export type AccountNoticeCode = keyof typeof ACCOUNT_NOTICES;

/** What an unrecognised error code gets — never the code itself. */
const GENERIC = ACCOUNT_ERRORS["account-failed"];

/** The first member of a repeated parameter, the value itself otherwise — the router hands over either. */
const first = (raw: string | string[] | undefined): string | undefined =>
  Array.isArray(raw) ? raw[0] : raw;

/**
 * D68 totality, `signupErrorMessage`'s contract: absent → nothing, anything
 * present and unknown → the one generic sentence. `Object.hasOwn`, never `in`:
 * `?error=toString` walks the prototype chain through `in` and comes back
 * with a function.
 */
export function accountErrorMessage(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const code = first(raw);
  if (typeof code !== "string") return GENERIC;
  return Object.hasOwn(ACCOUNT_ERRORS, code) ? ACCOUNT_ERRORS[code as AccountErrorCode] : GENERIC;
}

/**
 * A notice is the one URL read on this surface where unknown means NOTHING
 * rather than a generic sentence: a notice claims something happened, and a
 * sentence about an outcome this vocabulary cannot name would be a claim the
 * page has no row behind. Absent → nothing; a member → its sentence; anything
 * else → nothing.
 */
export function accountNotice(raw: string | string[] | undefined): string | null {
  const code = first(raw);
  if (typeof code !== "string") return null;
  return Object.hasOwn(ACCOUNT_NOTICES, code) ? ACCOUNT_NOTICES[code as AccountNoticeCode] : null;
}

/**
 * The section a code belongs to, from its first word (D712). Total: a code
 * with no section word — `account-failed`, and anything the vocabularies do
 * not contain — lands at the page level.
 */
export function sectionOf(code: string): AccountSection {
  const word = code.split("-")[0];
  if (word === "name" || word === "email" || word === "password" || word === "avatar") return word;
  if (word === "session" || word === "sessions") return "sessions";
  return "account";
}

/**
 * The page's one read of both parameters: an error outranks a notice, because
 * a URL carrying both was not written by any action here (each redirect
 * carries exactly one) and the refusal is the safer thing to show. The section
 * is derived from the RESOLVED code, so a hostile value that fell through to
 * the generic sentence lands at the page level, never in a section a link
 * author picked.
 */
export function accountFeedback(params: {
  error?: string | string[];
  saved?: string | string[];
}): AccountFeedback | null {
  const error = accountErrorMessage(params.error);
  if (error !== null) {
    const code = first(params.error);
    const known = typeof code === "string" && Object.hasOwn(ACCOUNT_ERRORS, code);
    return { kind: "error", section: known ? sectionOf(code) : "account", message: error };
  }
  const notice = accountNotice(params.saved);
  if (notice !== null) {
    // `accountNotice` answered, so the code is a member and `first` is a string.
    return { kind: "notice", section: sectionOf(first(params.saved) as string), message: notice };
  }
  return null;
}

/**
 * Which code a failed account write IS. Pure, and out of `actions.ts`, because
 * a `"use server"` module may export nothing but async functions and a mapping
 * trapped there cannot be tested at all (D133).
 *
 * Two families reach it. Our own four — `EmailTaken` and `UnknownSession`
 * (`server/account.ts`), `AvatarTooLarge` and `AvatarNotImage`
 * (`server/avatars.ts`) — matched by `name`, like the `APIError` check, so no
 * error class is imported to be matched against. And better-auth's `APIError`,
 * whose machine-readable `body.code` is what the arms read:
 *
 * - `INVALID_PASSWORD`, `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG` are
 *   `/change-password`'s three refusals a person can act on
 *   (`routes/update-user.mjs`); `CREDENTIAL_ACCOUNT_NOT_FOUND` is deliberately
 *   generic — every account here has a password, so it names nothing a reader
 *   can do differently.
 * - `VALIDATION_ERROR` with the `[body.newEmail]` prefix is `/change-email`'s
 *   body schema refusing a malformed address (MEASURED at 1.7.1 with this
 *   config: it fires before the session middleware, and the field is named
 *   only in the message — the same shape as signup's `[body.email]` arm).
 *   `INVALID_EMAIL` stays as defense in depth for the same reason signup keeps
 *   it.
 * - `Email is the same` is codeless (`APIError.fromStatus`, the invite
 *   surface's `Invitation not found!` shape), so the message is the arm. The
 *   action refuses the same input a step earlier from the session's own
 *   address; this arm is what keeps the property if that check ever moves.
 *
 * Total by construction: anything else is `account-failed`.
 */
export function accountErrorCode(error: unknown): AccountErrorCode {
  const named = error as { name?: string; body?: { code?: string; message?: string } } | null;
  if (named?.name === "EmailTaken") return "email-taken";
  if (named?.name === "UnknownSession") return "session-not-found";
  // `server/avatars.ts`'s two refusals (D718): the store's CHECKs stated as classes.
  if (named?.name === "AvatarTooLarge") return "avatar-too-large";
  if (named?.name === "AvatarNotImage") return "avatar-not-image";
  if (named?.name === "APIError") {
    switch (named.body?.code) {
      case "INVALID_PASSWORD":
        return "password-incorrect";
      case "PASSWORD_TOO_SHORT":
        return "password-short";
      case "PASSWORD_TOO_LONG":
        return "password-long";
      case "INVALID_EMAIL":
        return "email-invalid";
      case "VALIDATION_ERROR":
        if (named.body?.message?.startsWith("[body.newEmail]")) return "email-invalid";
        break;
    }
    if (named.body?.message === "Email is the same") return "email-same";
  }
  return "account-failed";
}
