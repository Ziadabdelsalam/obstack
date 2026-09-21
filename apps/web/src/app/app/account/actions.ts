"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AVATAR_MAX_BYTES, PASSWORD_MAX, PASSWORD_MIN } from "@/lib/account-types";
import {
  changePassword,
  changeSignInEmail,
  parseDisplayName,
  parseSessionId,
  readAccount,
  revokeOtherOwnSessions,
  revokeOwnSession,
  updateDisplayName,
  type AccountSession,
} from "@/server/account";
import { deleteAvatar, putAvatar } from "@/server/avatars";
import { dataMode } from "@/server/data";
import { queryRows } from "@/server/postgres";
import { checkRateLimit } from "@/server/rate-limit";
import { accountErrorCode, type AccountErrorCode, type AccountNoticeCode } from "./errors";

/**
 * Everything the account surface WRITES (D707): the signed-in person's name,
 * sign-in address and password, and which of their sessions stay alive. Reads
 * are the page's (D182); nothing here answers a question.
 *
 * That is the authorization, whole, and it is the settings actions' shape
 * (D148): a Server Function is reachable by a direct POST and not only through
 * the UI (Next's own warning, `node_modules/next/dist/docs/01-app/
 * 01-getting-started/07-mutating-data.md`), so every function below resolves
 * the session on the server and operates on THAT user and THAT session row.
 * The client names a session id, a name, an address or a password — never a
 * user.
 *
 * Every exit is a redirect (D189's POST-redirect-GET): a refusal leaves
 * through `?error=<code>` and a success through `?saved=<code>`, both members
 * of literal unions, so nothing a caller supplies reaches the query string
 * (D121). The fresh GET renders the row as it now is, which is what makes the
 * notice a fact rather than a claim carried in the response.
 */

const ACCOUNT_PATH = "/app/account";

/** The one exit for a failure: a code, never text, never the caller's input. */
const back: (code: AccountErrorCode) => never = (code) => redirect(`${ACCOUNT_PATH}?error=${code}`);

/** The one exit for a success: the row changed, and the fresh GET will show it. */
const done: (notice: AccountNoticeCode) => never = (notice) =>
  redirect(`${ACCOUNT_PATH}?saved=${notice}`);

/**
 * An error the vocabulary could not name is one an operator has to see, and
 * `account-failed` is produced by nothing but that fallback (signup's split).
 */
function codeFor(where: string, error: unknown): AccountErrorCode {
  const code = accountErrorCode(error);
  if (code === "account-failed") console.error(`[account] ${where}`, error);
  return code;
}

/**
 * The gate every action opens with, the settings gate's shape (D150/D152). The
 * MODE CHECK COMES FIRST and short-circuits before `readAccount` — which
 * builds the auth instance and opens a pool — because mock mode is the
 * fictional-data prototype: no accounts, no `BETTER_AUTH_SECRET`, no Postgres.
 * The mock page renders no form, so a post that gets here came from somewhere
 * no visitor can be; the log line is the tripwire and no code is emitted,
 * because the vocabulary answers a real attempt and this is not one.
 *
 * A caller with no session goes to /login rather than getting a code: there is
 * nothing on this page for them to read a message on.
 */
async function accountSession(
  where: string,
): Promise<{ account: AccountSession; requestHeaders: Headers }> {
  if (dataMode === "mock") {
    console.error(`[account] ${where} posted in mock mode — this deployment keeps no accounts`);
    redirect(ACCOUNT_PATH);
  }
  const requestHeaders = await headers();
  const account = await readAccount(requestHeaders);
  if (!account) redirect("/login");
  return { account, requestHeaders };
}

/** Rename the signed-in person. The parse is total (D68); the write is the library's. */
export async function updateName(formData: FormData): Promise<void> {
  const { requestHeaders } = await accountSession("update name");

  const name = parseDisplayName(formData.get("name"));
  if (!name) back("name-invalid");

  // Only the write is inside the try: `redirect` signals through a thrown
  // error, so a `back()` reached from inside a catch is fine and one reached
  // from inside a try would be swallowed by it.
  try {
    await updateDisplayName(name, requestHeaders);
  } catch (error) {
    back(codeFor("update name", error));
  }
  done("name");
}

/**
 * Change the sign-in address (D709). Lower-cased here because that is what the
 * library stores and compares, so "same address" is judged the way the row
 * will hold it. The blank check and the same-address check are ours and cost
 * no attempt; the address's validity is better-auth's `z.email()` — one
 * definition of what a valid address is, and it is the one that decides
 * (the invite action's rule). The rate limit (D713) counts every attempt that
 * reaches the store, because the taken-address answer this surface gives is
 * the disclosure `/signup` already makes, and a per-account budget is what
 * keeps it from becoming a lookup.
 */
export async function updateEmail(formData: FormData): Promise<void> {
  const { account, requestHeaders } = await accountSession("update email");

  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!email) back("email-missing");
  if (email === account.email.toLowerCase()) back("email-same");
  if (!checkRateLimit("email", account.userId)) back("email-rate-limited");

  try {
    await changeSignInEmail(account.userId, email, requestHeaders, queryRows);
  } catch (error) {
    back(codeFor("update email", error));
  }
  done("email");
}

/**
 * Change the password (D710). The shape checks — present, matching, different,
 * inside the documented bounds — are answered before anything is counted or
 * called: none of them touches the current password, so none of them is an
 * attempt at it. What IS an attempt is the verify inside the library, and the
 * rate limit (D713) sits exactly in front of that: five wrong current
 * passwords in ten minutes and the account's budget is spent, whatever the
 * cookie says.
 *
 * "Also sign out every other session" is a second step after the change, on
 * purpose (`server/account.ts`'s `changePassword` says why): the library's own
 * revoke would re-create THIS session without its address and browser. If that
 * second step fails, the password has still changed — the notice for that
 * outcome is not reached, the refusal names the sessions step, and the list
 * below it still carries the button that finishes the job.
 */
export async function updatePassword(formData: FormData): Promise<void> {
  const { account, requestHeaders } = await accountSession("change password");

  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  const revokeOthers = formData.get("revokeOthers") === "1";

  if (!currentPassword || !newPassword || !confirmPassword) back("password-missing");
  if (newPassword !== confirmPassword) back("password-mismatch");
  if (newPassword === currentPassword) back("password-unchanged");
  if (newPassword.length < PASSWORD_MIN) back("password-short");
  if (newPassword.length > PASSWORD_MAX) back("password-long");
  if (!checkRateLimit("password", account.userId)) back("password-rate-limited");

  try {
    await changePassword({ currentPassword, newPassword }, requestHeaders);
  } catch (error) {
    back(codeFor("change password", error));
  }
  if (!revokeOthers) done("password");

  try {
    await revokeOtherOwnSessions(account.userId, account.sessionId, queryRows);
  } catch (error) {
    back(codeFor("sign out other sessions after a password change", error));
  }
  done("password-sessions");
}

/**
 * End one of this account's OTHER sessions. The id is parsed totally (D68) and
 * then judged by the DELETE's own predicate (`server/account.ts`): a foreign
 * id, a spent id and this request's own session id all come back as the same
 * `session-not-found`, which is what a stale list deserves and nothing a
 * caller could learn from.
 */
export async function revokeSession(formData: FormData): Promise<void> {
  const { account } = await accountSession("sign out a session");

  const sessionId = parseSessionId(formData.get("sessionId"));
  if (!sessionId) back("session-not-found");

  try {
    await revokeOwnSession(account.userId, sessionId, account.sessionId, queryRows);
  } catch (error) {
    back(codeFor("sign out a session", error));
  }
  done("session");
}

/** End every session but this one. No field to read, so no parse: the session row is the whole input. */
export async function revokeOtherSessions(): Promise<void> {
  const { account } = await accountSession("sign out other sessions");

  try {
    await revokeOtherOwnSessions(account.userId, account.sessionId, queryRows);
  } catch (error) {
    back(codeFor("sign out other sessions", error));
  }
  done("sessions");
}

/**
 * Store a picture (D718). The upload arrives as a `File` in the form's
 * multipart body — the picker shrinks it to `AVATAR_EDGE_PX` first when
 * JavaScript is on, and posts the original otherwise — and it is judged before
 * it is read: absent, then over the cap by its declared size (the store's own
 * CHECK, stated once in `lib/account-types.ts`), so a body past the limit is
 * never buffered into memory. The bytes decide the type (`server/avatars.ts`),
 * never the browser's declared MIME.
 */
export async function uploadAvatar(formData: FormData): Promise<void> {
  const { account } = await accountSession("upload picture");

  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) back("avatar-missing");
  if (file.size > AVATAR_MAX_BYTES) back("avatar-too-large");

  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    await putAvatar(account.userId, bytes, queryRows);
  } catch (error) {
    back(codeFor("upload picture", error));
  }
  done("avatar");
}

/** Remove the picture; the initials render from then on. No field to read, so no parse. */
export async function removeAvatar(): Promise<void> {
  const { account } = await accountSession("remove picture");

  try {
    await deleteAvatar(account.userId, queryRows);
  } catch (error) {
    back(codeFor("remove picture", error));
  }
  done("avatar-removed");
}
