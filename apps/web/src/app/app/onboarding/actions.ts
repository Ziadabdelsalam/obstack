"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { issueApiKey, parseKeyName } from "@/server/api-keys";
import { dataMode } from "@/server/data";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * The quickstart's ONE write: issue this workspace's key so the snippets can
 * carry a token an operator can actually paste (D201).
 *
 * The surface needs issuance rather than the key list because a stored token is
 * unrecoverable by design — `issueApiKey` keeps only its hash (D98) — so a
 * prefix is not something anyone can export with, and "renders the workspace's
 * real key" has exactly one honest implementation. The token lives in the
 * response and in the client component's state, and nowhere else: never in a
 * URL, never persisted, gone on unmount (D201).
 *
 * Reads on this route are the page's (D182); nothing here answers a question.
 */

const ONBOARDING_PATH = "/app/onboarding";

/** What a key issued from the quickstart is called when the caller names nothing. */
const DEFAULT_KEY_NAME = "Quickstart";

/**
 * The same gate the settings actions open with (D150/D152), for the same
 * reasons: the MODE CHECK COMES FIRST and short-circuits before
 * `getSessionContext` builds the auth instance and opens a pool, because the
 * mock deployment has no accounts, no `BETTER_AUTH_SECRET` and no Postgres.
 * Mock mode renders no issue affordance, so a post that gets here came from
 * somewhere no visitor can be — the log line is the tripwire, and it is
 * `console.error` because it cannot happen through honest use (D193).
 *
 * A caller with no session goes to /login: there is nothing on this page for
 * them to read a message on.
 */
async function onboardingSession(where: string) {
  if (dataMode === "mock") {
    console.error(`[onboarding] ${where} posted in mock mode — this deployment keeps no accounts`);
    redirect(ONBOARDING_PATH);
  }
  const session = await getSessionContext();
  if (!session) redirect("/login");
  return session;
}

/**
 * Issue a key and hand the token back exactly once — the second action in the
 * product that answers with a value instead of a redirect, and for the identical
 * reason settings' `issueKey` does: a token in a query string is a token in the
 * browser's history, in a referrer and in every access log the response passes
 * through (`app/app/settings/actions.ts`, whose note this one mirrors).
 *
 * The name is ours by default and parsed by the same `parseKeyName` the settings
 * form's is, so a hand-crafted post cannot store a name the key list refuses to
 * show. A refused name or a failed write leaves through a bare redirect back to
 * this page: the quickstart has no error vocabulary because it has no field to
 * get wrong — every honest press sends no name at all.
 */
export async function issueQuickstartKey(formData: FormData): Promise<{ token: string }> {
  const session = await onboardingSession("issue key");

  const name = parseKeyName(formData.get("name") ?? DEFAULT_KEY_NAME);
  if (!name) redirect(ONBOARDING_PATH);

  // Only the write is inside the try: `redirect` signals through a thrown error,
  // so one reached from inside a try would be swallowed by it.
  let issued: string;
  try {
    issued = (await issueApiKey(session.workspaceId, name, queryRows)).token;
  } catch (error) {
    console.error("[onboarding] issue key", error);
    redirect(ONBOARDING_PATH);
  }
  // Refreshes the server-rendered key list in the same roundtrip, so the new
  // key's prefix appears beside the snippet holding its token.
  revalidatePath(ONBOARDING_PATH);
  return { token: issued };
}
