"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { OverrideResult } from "@/components/settings/SettingsSuite";
import { issueApiKey, parseKeyName, revokeApiKey } from "@/server/api-keys";
import { dataMode } from "@/server/data";
import {
  deletePricingOverride,
  parseOverrideMatch,
  parsePricePerMTok,
  upsertPricingOverride,
} from "@/server/ingest-health";
import { cancelInvite, createInvite } from "@/server/invites";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";
import { SETTINGS_ERRORS, settingsErrorCode, type SettingsErrorCode } from "./errors";

/**
 * Everything the settings surface WRITES: API keys (`server/api-keys.ts`),
 * invitations (`server/invites.ts`) and pricing overrides
 * (`server/ingest-health.ts`), behind one session gate and one error vocabulary
 * (`errors.ts`). Writes only — every read on this page is the page's (D182), so
 * nothing here is reachable by opening a tab. Nothing here takes a workspace or
 * an org from its caller.
 *
 * That is the authorization, whole (D148): a Server Function is reachable by a
 * direct POST and not only through the UI (Next's own warning, `node_modules/
 * next/dist/docs/01-app/01-getting-started/07-mutating-data.md`), so every
 * function below resolves the session on the server and operates on THAT
 * workspace and THAT org. The client names a key id, a name or an email — never
 * a tenant.
 *
 * Failures leave through `?error=<code>`, a member of a literal union, so
 * nothing a caller supplies can reach the query string (D121). Successes
 * revalidate the page and return, because the surface that issued a key needs
 * the token back in the SAME response — see `issueKey`.
 *
 * The two override writes are the exception, and only in the ROUTE their
 * refusal takes: they answer with the sentence instead of redirecting to it,
 * because a redirect re-renders the tab and would throw away the three fields
 * the operator typed. The words are the same vocabulary's (`errors.ts` — D182),
 * so the D121 property is unchanged: the sentences are constants and a caller's
 * value is never interpolated into one.
 */

const SETTINGS_PATH = "/app/settings";

/** The one exit for a failure: a code, never text, never the caller's input. */
// Annotated on the CONST rather than on the arrow: `never` only narrows the code
// after a call when the identifier carries an explicit type, which is what lets
// `back("key-name-invalid")` stand as a refusal instead of falling through.
const back: (code: SettingsErrorCode) => never = (code) =>
  redirect(`${SETTINGS_PATH}?error=${code}`);

/**
 * An error the vocabulary could not name is one an operator has to see, and
 * `settings-failed` is produced by nothing but that fallback (signup's split).
 */
function codeFor(where: string, error: unknown): SettingsErrorCode {
  const code = settingsErrorCode(error);
  if (code === "settings-failed") console.error(`[settings] ${where}`, error);
  return code;
}

/**
 * The gate every action below opens with. The MODE CHECK COMES FIRST and
 * short-circuits before `getSessionContext` — which builds the auth instance and
 * opens a pool — because mock mode is the fictional-data prototype: it has no
 * accounts, no `BETTER_AUTH_SECRET` and no Postgres, and reaching for any of
 * them is the failure this branch exists to prevent (D150/D152, the same shape
 * signup, login and the invite accept action carry). Mock renders no settings
 * form, so a post that gets here came from somewhere no visitor can be; the log
 * line is the tripwire and no error code is emitted, because the vocabulary
 * answers a real attempt and this is not one.
 *
 * A caller with no session goes to /login rather than getting a code: there is
 * nothing on this page for them to read a message on.
 */
async function settingsSession(where: string) {
  if (dataMode === "mock") {
    console.error(`[settings] ${where} posted in mock mode — this deployment keeps no accounts`);
    redirect(SETTINGS_PATH);
  }
  const session = await getSessionContext();
  if (!session) redirect("/login");
  return session;
}

/**
 * Issue a key, and hand the token back exactly once.
 *
 * This is the ONE action that answers with a value instead of a redirect, and
 * the reason is the secret: a token in a query string is a token in the
 * browser's history, in a referrer and in every access log the response passes
 * through. It exists in this response and nowhere else — `issueApiKey` stores
 * only its hash (D98), so there is no second chance to read it and no code path
 * that could offer one.
 *
 * `revalidatePath` refreshes the server-rendered list in the same roundtrip, so
 * the new key appears beside the banner showing its token without a reload.
 */
export async function issueKey(formData: FormData): Promise<{ token: string }> {
  const session = await settingsSession("issue key");

  const name = parseKeyName(formData.get("name"));
  if (!name) back("key-name-invalid");

  // The write is the only thing inside the try: `redirect` signals through a
  // thrown error, so a `back()` reached from inside a catch is fine and one
  // reached from inside a try would be swallowed by it.
  let issued: string;
  try {
    issued = (await issueApiKey(session.workspaceId, name, queryRows)).token;
  } catch (error) {
    return back(codeFor("issue key", error));
  }
  revalidatePath(SETTINGS_PATH);
  return { token: issued };
}

/**
 * Revoke one of this workspace's keys.
 *
 * The id is bound as a parameter and judged by the WHERE clause's workspace
 * (`server/api-keys.ts`), so a hostile or foreign id needs no parse of its own
 * here: it matches no row, and `UnknownApiKey` becomes `key-not-found` — the
 * same answer a stale tab gets, and nothing a caller could learn from.
 */
export async function revokeKey(formData: FormData): Promise<void> {
  const session = await settingsSession("revoke key");

  try {
    await revokeApiKey(session.workspaceId, String(formData.get("keyId") ?? ""), queryRows);
  } catch (error) {
    back(codeFor("revoke key", error));
  }
  revalidatePath(SETTINGS_PATH);
}

/**
 * Invite a teammate into the caller's own org (D148: the org is the owner pin,
 * never a form field). No email is sent — the pending list renders the copyable
 * link (D143's U4 answer), so a successful invite just refreshes the page.
 *
 * The blank check is ours; the address's validity is better-auth's `z.email()`
 * (MEASURED, `crud-invites.mjs:87`), whose `INVALID_EMAIL` the vocabulary maps.
 * One definition of what a valid address is, and it is the one that decides.
 */
export async function inviteTeammate(formData: FormData): Promise<void> {
  const session = await settingsSession("invite teammate");

  const email = String(formData.get("email") ?? "").trim();
  if (!email) back("invite-email-missing");

  try {
    await createInvite(session.orgId, email, await headers());
  } catch (error) {
    back(codeFor("invite teammate", error));
  }
  revalidatePath(SETTINGS_PATH);
}

/**
 * Cancel one of this org's pending invitations. `cancelInvite` refuses an
 * invitation belonging to another org before the library sees it — that refusal
 * is not in the vocabulary on purpose: it means a stale tab or a direct POST,
 * neither of which the generic sentence misleads, and the log line names it.
 */
export async function cancelInvitation(formData: FormData): Promise<void> {
  const session = await settingsSession("cancel invitation");

  try {
    await cancelInvite(session.orgId, String(formData.get("invitationId") ?? ""), await headers());
  } catch (error) {
    back(codeFor("cancel invitation", error));
  }
  revalidatePath(SETTINGS_PATH);
}

/* ---------------- Data & ingest ---------------- */

/**
 * The other exit, for the two writes that must not redirect: the same code,
 * resolved to the same sentence, handed back as a value. `back` and this are
 * the only two ways a failure leaves this module.
 */
const refused = (code: SettingsErrorCode): OverrideResult => ({ error: SETTINGS_ERRORS[code] });

/**
 * Set this workspace's price for a model prefix (D108) — one call for create
 * and edit, because the row's identity is (workspace, match) and there is no
 * second thing an operator could mean by naming a match they already have.
 *
 * Every field is parsed totally before anything is written (D68), and the cap
 * is the store's, enforced inside the INSERT rather than checked here: two tabs
 * at ninety-nine overrides must not both be told they have room.
 *
 * A success revalidates and answers with nothing, exactly like `revokeKey`: the
 * new list arrives as the page's own read in the same roundtrip, so there is one
 * definition of what the tab shows and it is the one on `page.tsx`.
 */
export async function saveOverride(formData: FormData): Promise<OverrideResult> {
  const session = await settingsSession("save price override");

  const match = parseOverrideMatch(formData.get("match"));
  const inputPerMTok = parsePricePerMTok(formData.get("inputPerMTok"));
  const outputPerMTok = parsePricePerMTok(formData.get("outputPerMTok"));

  if (!match) return refused("override-match-invalid");
  if (inputPerMTok === null || outputPerMTok === null) return refused("override-price-invalid");

  try {
    await upsertPricingOverride(
      session.workspaceId,
      { match, inputPerMTok, outputPerMTok },
      queryRows,
    );
  } catch (failure) {
    return refused(codeFor("save price override", failure));
  }
  revalidatePath(SETTINGS_PATH);
  return { error: null };
}

/**
 * Remove one of this workspace's overrides; the models it matched fall back to
 * the embedded list on ingest's next cache refresh. The id is judged by the
 * DELETE's workspace predicate, so a foreign or hostile id needs no parse of
 * its own: it matches no row and comes back as the same sentence a stale tab
 * gets.
 */
export async function deleteOverride(formData: FormData): Promise<OverrideResult> {
  const session = await settingsSession("remove price override");

  try {
    await deletePricingOverride(
      session.workspaceId,
      String(formData.get("overrideId") ?? ""),
      queryRows,
    );
  } catch (failure) {
    return refused(codeFor("remove price override", failure));
  }
  revalidatePath(SETTINGS_PATH);
  return { error: null };
}
