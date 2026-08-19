"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { IngestFormResult, LiveIngest } from "@/components/settings/SettingsSuite";
import { issueApiKey, parseKeyName, revokeApiKey } from "@/server/api-keys";
import { dataMode } from "@/server/data";
import {
  BASE_PRICES_AS_OF,
  BASE_PRICES_COUNT,
  OVERRIDE_MAX,
  OVERRIDE_MATCH_MAX,
  PRICE_PER_MTOK_MAX,
  deletePricingOverride,
  getIngestHealth,
  listPricingOverrides,
  parseOverrideMatch,
  parsePricePerMTok,
  upsertPricingOverride,
} from "@/server/ingest-health";
import { cancelInvite, createInvite } from "@/server/invites";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";
import { settingsErrorCode, type SettingsErrorCode } from "./errors";

/**
 * Everything the settings surface WRITES: API keys (`server/api-keys.ts`),
 * invitations (`server/invites.ts`) and pricing overrides
 * (`server/ingest-health.ts`), behind one session gate and one error vocabulary
 * (`errors.ts`). The page's reads stay on the page; the ONE read here is the
 * Data & ingest tab's, which loads itself when it is opened rather than making
 * every other tab pay for rows only it shows. Nothing here takes a workspace or
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
 * UTC and formatted here, for the reason `page.tsx` gives about its own
 * formatters: a timestamp formatted on both sides of hydration is formatted in
 * two timezones and the two renders disagree. The server is the only side that
 * knows what clock these rows were written on.
 */
const asMinute = (at: Date): string => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const asDay = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * The sentences the overrides form can answer with. They are returned as
 * VALUES rather than emitted as `?error=` codes, and that is the difference
 * between this list and `errors.ts`: the closed vocabulary exists because a
 * code has to survive a redirect and a URL must never carry a caller's text.
 * Nothing here redirects — the tab is loaded and rewritten in place — so the
 * copy travels as copy, and the form the operator typed into survives the
 * refusal that a redirect would have thrown away.
 *
 * The cap sentence states the number the INSERT enforces by reading the same
 * constant (D164(f) asks for the cap to be IN the error, not only in a doc).
 */
const OVERRIDE_ERRORS = {
  match: `Use the start of a model name — letters, digits, . _ : / - and up to ${OVERRIDE_MATCH_MAX} characters, like gpt-4o or your fine-tune's name.`,
  price: `Each price is US dollars per million tokens: a number from 0 to ${PRICE_PER_MTOK_MAX.toLocaleString("en-US")}.`,
  limit: `This workspace already has ${OVERRIDE_MAX} price overrides, which is the most it can hold. Remove one to add another.`,
  missing: "That override isn't one of this workspace's. The list below is the current one.",
  failed: "That didn't work. Please try again.",
} as const;

/** Same split as `codeFor`: a failure the surface can name, or one an operator must see. */
function overrideError(where: string, error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "OverrideLimit") return OVERRIDE_ERRORS.limit;
  if (name === "UnknownOverride") return OVERRIDE_ERRORS.missing;
  console.error(`[settings] ${where}`, error);
  return OVERRIDE_ERRORS.failed;
}

/**
 * The tab's whole state, read after every one of its calls — a write answers
 * with the list as it now stands, so the screen cannot show a list that
 * predates the write that just returned. Two statements in parallel, which is
 * the parallelism the Next docs point a Server Function at (07-mutating-data,
 * "perform parallel work inside a single Server Function").
 */
async function ingestState(workspaceId: string): Promise<LiveIngest> {
  const [health, overrides] = await Promise.all([
    getIngestHealth(workspaceId, queryRows),
    listPricingOverrides(workspaceId, queryRows),
  ]);

  return {
    keys: health.keys.map((key) => ({
      keyId: key.keyId,
      name: key.name,
      prefix: key.prefix,
      revoked: key.revoked,
      accepted: key.accepted,
      errors: key.droppedDecode + key.droppedUnsupported,
      sampled: key.droppedQuota,
      lastEvent: key.lastEventAt ? asMinute(key.lastEventAt) : null,
    })),
    accepted: health.accepted,
    receiveErrors: health.receiveErrors,
    droppedQuota: health.droppedQuota,
    asOf: health.asOf ? asMinute(health.asOf) : null,
    overrides: overrides.map((override) => ({
      id: override.id,
      match: override.match,
      inputPerMTok: override.inputPerMTok,
      outputPerMTok: override.outputPerMTok,
      updated: asDay(override.updatedAt),
    })),
    overrideMax: OVERRIDE_MAX,
    pricesAsOf: BASE_PRICES_AS_OF,
    pricedModels: BASE_PRICES_COUNT,
  };
}

/**
 * The Data & ingest tab's load. A read behind a POST is unusual and deliberate:
 * this is the one surface on the page whose rows nobody else needs, and it is
 * reachable by a direct POST like every Server Function, so it opens with the
 * same gate the writes do and answers for the SESSION's workspace only (D148).
 */
export async function loadIngestHealth(): Promise<IngestFormResult> {
  const session = await settingsSession("load ingest health");
  return { ingest: await ingestState(session.workspaceId), error: null };
}

/**
 * Set this workspace's price for a model prefix (D108) — one call for create
 * and edit, because the row's identity is (workspace, match) and there is no
 * second thing an operator could mean by naming a match they already have.
 *
 * Every field is parsed totally before anything is written (D68), and the cap
 * is the store's, enforced inside the INSERT rather than checked here: two tabs
 * at ninety-nine overrides must not both be told they have room.
 */
export async function saveOverride(formData: FormData): Promise<IngestFormResult> {
  const session = await settingsSession("save price override");

  const match = parseOverrideMatch(formData.get("match"));
  const inputPerMTok = parsePricePerMTok(formData.get("inputPerMTok"));
  const outputPerMTok = parsePricePerMTok(formData.get("outputPerMTok"));

  let error: string | null = null;
  if (!match) {
    error = OVERRIDE_ERRORS.match;
  } else if (inputPerMTok === null || outputPerMTok === null) {
    error = OVERRIDE_ERRORS.price;
  } else {
    try {
      await upsertPricingOverride(
        session.workspaceId,
        { match, inputPerMTok, outputPerMTok },
        queryRows,
      );
    } catch (failure) {
      error = overrideError("save price override", failure);
    }
  }

  return { ingest: await ingestState(session.workspaceId), error };
}

/**
 * Remove one of this workspace's overrides; the models it matched fall back to
 * the embedded list on ingest's next cache refresh. The id is judged by the
 * DELETE's workspace predicate, so a foreign or hostile id needs no parse of
 * its own: it matches no row and comes back as the same sentence a stale tab
 * gets.
 */
export async function deleteOverride(formData: FormData): Promise<IngestFormResult> {
  const session = await settingsSession("remove price override");

  let error: string | null = null;
  try {
    await deletePricingOverride(
      session.workspaceId,
      String(formData.get("overrideId") ?? ""),
      queryRows,
    );
  } catch (failure) {
    error = overrideError("remove price override", failure);
  }

  return { ingest: await ingestState(session.workspaceId), error };
}
