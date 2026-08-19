/**
 * The closed vocabulary of `/invite/<id>?error=` (D149, same shape as
 * `signup/errors.ts` per D121/D127/D133). The action emits a CODE and this
 * module owns the words; the query value never reaches the page, so a link
 * author cannot put text of their choosing on a screen someone is about to join
 * an organization from.
 *
 * The three members are what better-auth 1.7.1 can actually distinguish, and no
 * more. MEASURED, and the reason there is one `not-found` rather than the three
 * separate sentences one might expect: an expired invitation, an already
 * accepted one, a cancelled one and an id that never existed all leave by the
 * SAME arm — `crud-invites.mjs:268` (accept) and `:503` (get) test
 * `!invitation || expired || status !== "pending"` together and raise one answer.
 * Copy that picked one of those four would be a guess, so the sentence names the
 * possibilities instead of claiming one.
 */
export const INVITE_ERRORS = {
  "not-found":
    "This invite link isn't usable any more. It may already have been accepted, cancelled, or expired — ask whoever invited you for a new one.",
  "not-recipient":
    "This invite was sent to a different email address. Sign in with the address it was sent to, then open the link again.",
  "invite-failed": "That invite couldn't be opened. Please try again.",
} as const;

export type InviteErrorCode = keyof typeof INVITE_ERRORS;

/** What an unrecognised code gets — never the code itself. */
const GENERIC = INVITE_ERRORS["invite-failed"];

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
export function inviteErrorMessage(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const code = Array.isArray(raw) ? raw[0] : raw;
  if (typeof code !== "string") return GENERIC;
  return Object.hasOwn(INVITE_ERRORS, code) ? INVITE_ERRORS[code as InviteErrorCode] : GENERIC;
}

/**
 * The other half of the vocabulary: which code a failed invite lookup or accept
 * IS. Pure, and out of `actions.ts`, because a `"use server"` module may export
 * nothing but async functions and a mapping trapped there cannot be tested at
 * all (D133).
 *
 * Two arms, both measured against better-auth 1.7.1's organization plugin:
 *
 * - `acceptInvitation` raises `APIError.from("BAD_REQUEST",
 *   ORGANIZATION_ERROR_CODES.INVITATION_NOT_FOUND)`, which carries
 *   `body.code = "INVITATION_NOT_FOUND"` (`defineErrorCodes` wraps each entry as
 *   `{code, message}`).
 * - `getInvitation` raises the same situation through
 *   `APIError.fromStatus("BAD_REQUEST", { message: "Invitation not found!" })` —
 *   codeless. So the message IS the arm on that path, the same shape signup's
 *   `[body.email]` prefix arm has. Two spellings of one library answer, and both
 *   have to be here or half the invite links in the world read "please try
 *   again" about a retry that can never work (D129).
 *
 * Everything else is generic on purpose. The membership-limit and
 * organization-missing failures say nothing a recipient can act on, and the
 * emailVerified guard cannot fire at all in this config — `authConfig()` sets no
 * `advanced.generateId` and no `advanced.database.generateId`, so
 * `shouldRequireVerifiedEmailForInvitationIdAction` (`crud-invites.mjs:30-36`)
 * returns false. `invites.integration.test.ts` asserts that rather than trusting
 * it, and a code that DID reach here would be logged by the action.
 */
export function inviteErrorCode(error: unknown): InviteErrorCode {
  const api = error as { name?: string; body?: { code?: string; message?: string } } | null;
  if (api?.name === "APIError") {
    if (api.body?.code === "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION") return "not-recipient";
    if (api.body?.code === "INVITATION_NOT_FOUND") return "not-found";
    if (api.body?.message === "Invitation not found!") return "not-found";
  }
  return "invite-failed";
}
