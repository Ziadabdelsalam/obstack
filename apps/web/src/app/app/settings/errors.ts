import {
  OVERRIDE_MATCH_MAX,
  OVERRIDE_MAX,
  PRICE_PER_MTOK_MAX,
} from "@/server/ingest-health";

/**
 * The closed vocabulary of `/app/settings` (D121/D127/D129, same shape as
 * `signup/errors.ts` and `invite/[id]/errors.ts`). The action emits a CODE and
 * this module owns the words; a caller's value never becomes a sentence, so
 * nothing a link author writes reaches a signed-in operator's settings screen.
 *
 * ONE vocabulary for the whole surface (D143's note, D182): settings is one page
 * and every refusal on it resolves here — keys, invites and the price overrides
 * together — with `settings-failed` as the single generic all three fall back
 * to. Two vocabularies on one page would be two definitions of the same thing.
 *
 * The codes take two ROUTES to the reader and the vocabulary does not care
 * which: an action that redirects puts the code in `?error=` and `page.tsx`
 * resolves it, and the two override writes — which must not redirect, because a
 * redirect would throw away the form the operator typed into — resolve it on the
 * server and return the sentence itself. Same map, same fallback, same D121
 * property either way.
 *
 * Every sentence names what the reader can do about it. The two the library
 * raises — already a member, already invited — are the ones an inviter actually
 * hits, and each says what already exists rather than "try again" about a retry
 * that would fail identically (D129).
 *
 * The three override sentences state the numbers the STORE enforces, read from
 * `server/ingest-health.ts` rather than retyped here (D164(f) asks for the cap
 * to be in the error): copy naming a limit the server does not keep is the same
 * lie D129 exists to prevent. That import makes this a server-side module — the
 * page and the actions resolve codes, the client component is handed finished
 * sentences and never a code.
 */
export const SETTINGS_ERRORS = {
  "key-name-invalid": "Give the key a name — 1 to 100 characters, so you can tell it apart later.",
  "key-not-found": "That key isn't one of this workspace's keys. Reload the page to see the current list.",
  "invite-email-missing": "Enter the email address of the person you're inviting.",
  "invite-email-invalid":
    "That email address isn't valid. Use a full address like teammate@example.com.",
  "invite-member-exists": "That person is already a member of this organization.",
  "invite-pending": "That address already has an open invite — copy the link from the list below.",
  "override-match-invalid": `Use the start of a model name — letters, digits, . _ : / - and up to ${OVERRIDE_MATCH_MAX} characters, like gpt-4o or your fine-tune's name.`,
  "override-price-invalid": `Each price is US dollars per million tokens: a number from 0 to ${PRICE_PER_MTOK_MAX.toLocaleString("en-US")}.`,
  "override-limit": `This workspace already has ${OVERRIDE_MAX} price overrides, which is the most it can hold. Remove one to add another.`,
  "override-not-found": "That override isn't one of this workspace's. The list below is the current one.",
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
 * our own three — `UnknownApiKey` (`server/api-keys.ts`), `OverrideLimit` and
 * `UnknownOverride` (`server/ingest-health.ts`) — matched by `name`, like the
 * `APIError` check, so no error class is imported to be matched against.
 *
 * Total by construction: anything else is `settings-failed`.
 */
export function settingsErrorCode(error: unknown): SettingsErrorCode {
  const named = error as { name?: string; body?: { code?: string } } | null;
  if (named?.name === "UnknownApiKey") return "key-not-found";
  if (named?.name === "OverrideLimit") return "override-limit";
  if (named?.name === "UnknownOverride") return "override-not-found";
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
