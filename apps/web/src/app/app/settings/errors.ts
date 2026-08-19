/**
 * The closed vocabulary of `/app/settings?error=` (D121/D127/D129, same shape as
 * `signup/errors.ts` and `invite/[id]/errors.ts`). The action emits a CODE and
 * this module owns the words; the query value itself never reaches the page, so
 * the parameter cannot carry text of a link author's choosing onto a signed-in
 * operator's settings screen.
 *
 * ONE vocabulary for the whole surface, keys and invites together (D143's note):
 * settings is one page with one `?error=` parameter, and two vocabularies on it
 * would be two definitions of the same thing — a code from either family has to
 * resolve to a sentence, and `settings-failed` is the single generic both fall
 * back to.
 *
 * Every sentence names what the reader can do about it. The two the library
 * raises — already a member, already invited — are the ones an inviter actually
 * hits, and each says what already exists rather than "try again" about a retry
 * that would fail identically (D129).
 */
export const SETTINGS_ERRORS = {
  "key-name-invalid": "Give the key a name — 1 to 100 characters, so you can tell it apart later.",
  "key-not-found": "That key isn't one of this workspace's keys. Reload the page to see the current list.",
  "invite-email-missing": "Enter the email address of the person you're inviting.",
  "invite-email-invalid":
    "That email address isn't valid. Use a full address like teammate@example.com.",
  "invite-member-exists": "That person is already a member of this organization.",
  "invite-pending": "That address already has an open invite — copy the link from the list below.",
  "settings-failed": "That didn't work. Please try again.",
} as const;

export type SettingsErrorCode = keyof typeof SETTINGS_ERRORS;

/** What an unrecognised code gets — never the code itself. */
const GENERIC = SETTINGS_ERRORS["settings-failed"];

/**
 * D68 totality: `error` comes off the URL, so it may be absent, repeated (the
 * router hands an array), or any hostile string. Absent is no message at all;
 * anything present that is not a member of the vocabulary is the one generic
 * sentence.
 *
 * `Object.hasOwn` rather than `in` or a bare lookup, for the reason
 * `signup/errors.ts` states: `?error=toString` walks the prototype chain through
 * either of those and comes back with a function.
 */
export function settingsErrorMessage(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const code = Array.isArray(raw) ? raw[0] : raw;
  if (typeof code !== "string") return GENERIC;
  return Object.hasOwn(SETTINGS_ERRORS, code) ? SETTINGS_ERRORS[code as SettingsErrorCode] : GENERIC;
}

/**
 * The other half of the same vocabulary: which code a failed settings action IS.
 * Pure, and out of `actions.ts`, because a `"use server"` module may export
 * nothing but async functions and a mapping trapped there cannot be tested at
 * all (D133).
 *
 * Two families of failure reach it. better-auth's `APIError` carries a
 * machine-readable `body.code`, and the three arms below are the ones
 * `createInvitation` raises for something the inviter can act on (MEASURED at
 * 1.7.1, `crud-invites.mjs:87`, `:127`, `:132`); the permission, member-not-found
 * and organization-not-found arms are deliberately generic, because none of them
 * describes anything an owner inviting into her own org can do differently. And
 * our own `UnknownApiKey` (`server/api-keys.ts`) — matched by `name`, like the
 * `APIError` check above it, so this module stays free of the server-only import
 * a client component could not follow.
 *
 * Total by construction: anything else is `settings-failed`.
 */
export function settingsErrorCode(error: unknown): SettingsErrorCode {
  const named = error as { name?: string; body?: { code?: string } } | null;
  if (named?.name === "UnknownApiKey") return "key-not-found";
  if (named?.name === "APIError") {
    switch (named.body?.code) {
      case "INVALID_EMAIL":
        return "invite-email-invalid";
      case "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION":
        return "invite-member-exists";
      case "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION":
        return "invite-pending";
    }
  }
  return "settings-failed";
}
