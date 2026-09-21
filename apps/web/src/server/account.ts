import "server-only";
import { NAME_MAX } from "@/lib/account-types";
import { getAuth } from "@/server/auth";
import type { QueryRows } from "@/server/postgres";

/**
 * The signed-in PERSON's own record (D707): name, sign-in address, password,
 * sessions and memberships. It is the one module in `src/server` scoped to a
 * user rather than a workspace, and nothing here takes or resolves a tenant —
 * none of it is tenant data. A session context answers WHICH workspace a
 * request reads (D114); this module never asks, and every statement below
 * binds the caller's user id as the owner pin instead (D148's rule, applied to
 * a person).
 *
 * Every write is one of two shapes, and the D120 allowlist moves for neither
 * (D708). The three that touch a credential or the address better-auth signs
 * in with — name, email, password — are in-process `auth.api.*` calls with the
 * request's own headers, the shape `server/invites.ts` fixed: the library keeps
 * its hash, its verify and its session-cookie refresh, and the HTTP doors
 * `/update-user`, `/change-email` and `/change-password` stay 404 to the
 * network (`auth.test.ts` names them as stay-closed entries). The two that end
 * sessions are `$1`-bound statements on the captured `session` table instead
 * (D711), for reasons the library's own routes give: `/list-sessions` runs
 * behind `freshSessionMiddleware`, which refuses any session older than
 * `freshAge` — 24 hours by default (`node_modules/better-auth/dist/context/
 * create-context.mjs`) — so a person who signed in yesterday could not see
 * their own sessions through it; and `/revoke-session` is keyed by the session
 * TOKEN (`routes/session.mjs`), the bearer secret this module must never hand
 * a page. A row identified by its id and judged by a WHERE clause that binds
 * the caller's user id (the `api-keys.ts` idiom) needs neither, and the store
 * is the only session authority this config has: no `secondaryStorage`, no
 * cookie cache, so a deleted row is a session that is over on its very next
 * request.
 */

/**
 * A display name, as a total parse (D68): trimmed, on one line, 1 to
 * `NAME_MAX` characters — or null. Control characters are refused because the
 * name is rendered into chrome the whole shell shares (the top bar, the
 * members roster); nothing else about its content is judged.
 */
export function parseDisplayName(raw: FormDataEntryValue | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/**
 * A session row's id, as a total parse (D68) — the same rule and the same
 * measurement as `parseInvitationId`: better-auth 1.7.1 generates every row id
 * with `createRandomStringGenerator("a-z", "A-Z", "0-9")(32)`
 * (`@better-auth/core/dist/utils/id.mjs`), and `account.integration.test.ts`
 * asserts a REAL session id against this regex. Looser than 32 and still
 * finite, so a library that lengthens its ids keeps working while nothing
 * outside the alphabet reaches a bound parameter. An id is only ever bound as
 * `$1` or compared, never used for a property lookup, which is why a
 * prototype name that happens to be alphanumeric is judged by the alphabet
 * alone.
 */
const SESSION_ID = /^[A-Za-z0-9]{1,64}$/;

export function parseSessionId(raw: FormDataEntryValue | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  return SESSION_ID.test(raw) ? raw : null;
}

/** Who is signed in, and on which session row — the two facts every account write binds. */
export interface AccountSession {
  userId: string;
  /** The `session` row this request arrived on: excluded from every revoke below, signed out from the top bar. */
  sessionId: string;
  name: string;
  email: string;
  createdAt: Date;
}

/**
 * The account behind the request, or null when there is no session. Read
 * through better-auth's own session endpoint with the request's headers — the
 * read the app layout already makes for its account line — because the user
 * row and the session row it arrived on are one answer there, and this module
 * needs both. Not memoized: the page and each action read it once.
 */
export async function readAccount(requestHeaders: Headers): Promise<AccountSession | null> {
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return null;
  return {
    userId: session.user.id,
    sessionId: session.session.id,
    name: session.user.name,
    email: session.user.email,
    createdAt: new Date(session.user.createdAt),
  };
}

/**
 * Rename the signed-in person. `/update-user` refuses an `email` in its body
 * (`EMAIL_CAN_NOT_BE_UPDATED`) and takes `name` and `image`; only the name is
 * ever sent — there is no image on this surface (D714), so no call here can
 * put one on the row.
 */
export async function updateDisplayName(name: string, requestHeaders: Headers): Promise<void> {
  await getAuth().api.updateUser({ body: { name }, headers: requestHeaders });
}

/**
 * The address already belongs to another account. Its own class rather than a
 * message so `account/errors.ts` can name it by `name` (the `UnknownApiKey`
 * idiom), and its own class at all because better-auth does not throw it: see
 * `changeSignInEmail`.
 */
export class EmailTaken extends Error {
  constructor(email: string) {
    super(`the address ${JSON.stringify(email)} already has an account`);
    this.name = "EmailTaken";
  }
}

const USER_EMAIL_SQL = `SELECT email FROM "user" WHERE id = $1`;

/**
 * Change the address the person signs in with (D709). The library does the
 * write — lower-casing the address, refusing one that fails `z.email()`
 * (measured: `VALIDATION_ERROR` with the message prefix `[body.newEmail]`,
 * raised by the body schema before any session read) and refusing the
 * address already on the account (`Email is the same`, codeless) — and the
 * `updateEmailWithoutVerification` flag in `authConfig()` is what lets it
 * write at all for an account that will never be verified (U4).
 *
 * The one thing the library will NOT say is that the address is taken. When
 * `newEmail` already belongs to another user it answers `{ status: true }`
 * and changes nothing (`routes/update-user.mjs`, "Change email attempt for
 * existing email") — an anti-enumeration answer that is right for a public
 * endpoint and wrong for this page, where "your email is updated" over an
 * unchanged row is the D13 lie. So the row is read back and the caller is
 * told the truth. The disclosure this makes is the one `/signup` already makes
 * with its `exists` member (D129), behind a per-account rate limit (D713),
 * and it is made to a signed-in person rather than to the internet.
 */
export async function changeSignInEmail(
  userId: string,
  newEmail: string,
  requestHeaders: Headers,
  query: QueryRows,
): Promise<void> {
  await getAuth().api.changeEmail({ body: { newEmail }, headers: requestHeaders });
  const [row] = await query<{ email: string }>(USER_EMAIL_SQL, [userId]);
  if (row?.email !== newEmail.toLowerCase()) throw new EmailTaken(newEmail);
}

/**
 * Change the password (D710), through the library's own verify-then-hash:
 * `INVALID_PASSWORD` for a wrong current one, `PASSWORD_TOO_SHORT` /
 * `PASSWORD_TOO_LONG` outside the documented 8–128 (`routes/update-user.mjs`).
 *
 * `revokeOtherSessions` is deliberately FALSE here even when the caller asked
 * for it. The library's own revoke deletes every session including the
 * current one and re-creates the current one bare — `createSession(userId)`
 * with no request context, so the new row carries no `ipAddress` and no
 * `userAgent` (`db/internal-adapter.mjs`), which would render this very
 * session as "unknown browser" in the list one paint later. The caller ends
 * the OTHER sessions with `revokeOtherOwnSessions` instead, which leaves the
 * current row exactly as it was. The two steps are not one transaction, and
 * the failure between them is stated rather than hidden: a password that
 * changed while the revoke failed is reported as the revoke's failure, the
 * other sessions are still listed, and one press on the list's own button
 * finishes the job.
 */
export async function changePassword(
  input: { currentPassword: string; newPassword: string },
  requestHeaders: Headers,
): Promise<void> {
  await getAuth().api.changePassword({
    body: {
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
      revokeOtherSessions: false,
    },
    headers: requestHeaders,
  });
}

/** One of the account's sessions, as the list shows it. NEVER the token (D711). */
export interface OwnSession {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  /** Null when better-auth recorded none — a request that carried no forwarded address (D359). */
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * The columns are named one by one, and `token` is not among them: this
 * statement is the only reader of the session table in the app, and
 * `account.test.ts` pins that the word never appears in it. Expired rows are
 * filtered out the way the library's own list does (`expiresAt > now()`) —
 * they are sessions nothing can use, not sessions a person could end.
 */
const OWN_SESSIONS_SQL = `
  SELECT id,
         "createdAt" AS created_at,
         "expiresAt" AS expires_at,
         NULLIF("ipAddress", '') AS ip_address,
         NULLIF("userAgent", '') AS user_agent
    FROM "session"
   WHERE "userId" = $1 AND "expiresAt" > now()
   ORDER BY "createdAt" DESC, id`;

export async function listOwnSessions(userId: string, query: QueryRows): Promise<OwnSession[]> {
  const rows = await query<{
    id: string;
    created_at: Date;
    expires_at: Date;
    ip_address: string | null;
    user_agent: string | null;
  }>(OWN_SESSIONS_SQL, [userId]);
  return rows.map((row) => ({
    id: row.id,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
  }));
}

/**
 * A revoke that named a session this account does not hold — or its own
 * current one, which the predicate below refuses the same way. One class for
 * both because from the page's side they are one situation: a stale list, or
 * a post from somewhere the page never offers a button.
 */
export class UnknownSession extends Error {
  constructor(sessionId: string) {
    super(`no other session ${JSON.stringify(sessionId)} on this account`);
    this.name = "UnknownSession";
  }
}

/**
 * The ownership check IS the WHERE clause (the `api-keys.ts` idiom): a foreign
 * or hostile id matches no row and comes back as `UnknownSession`, the same
 * answer a stale tab gets and nothing a caller could learn from. The current
 * session is excluded by the third predicate rather than by the page not
 * offering a button — a Server Function is reachable by a direct POST (Next's
 * own warning), and signing yourself out from a list that then re-renders for
 * nobody is the top bar's job, which lands on /login on purpose.
 */
const REVOKE_SESSION_SQL = `
  DELETE FROM "session"
   WHERE id = $1 AND "userId" = $2 AND id <> $3
  RETURNING id`;

export async function revokeOwnSession(
  userId: string,
  sessionId: string,
  currentSessionId: string,
  query: QueryRows,
): Promise<void> {
  const rows = await query<{ id: string }>(REVOKE_SESSION_SQL, [sessionId, userId, currentSessionId]);
  if (rows.length === 0) throw new UnknownSession(sessionId);
}

/** Every session but this one. Answers how many ended, which is a fact the page may state. */
const REVOKE_OTHERS_SQL = `
  DELETE FROM "session"
   WHERE "userId" = $1 AND id <> $2
  RETURNING id`;

export async function revokeOtherOwnSessions(
  userId: string,
  currentSessionId: string,
  query: QueryRows,
): Promise<number> {
  const rows = await query<{ id: string }>(REVOKE_OTHERS_SQL, [userId, currentSessionId]);
  return rows.length;
}

/** An organization this account belongs to, with the role its member row holds. */
export interface Membership {
  orgId: string;
  orgName: string;
  role: string;
  joinedAt: Date;
}

/**
 * Every membership, owner row first because signup wrote it first. Plain SQL
 * over two tables this repo already reads (`listOrgMembers` reads the same
 * join from the org's side), for D143's reason: a roster is not a reason to
 * reach for another `auth.api.*` call. What the list means is stated on the
 * page and pinned by `session.ts`: the session reads the workspace of the org
 * the account OWNS (D120), so a `member` row here records a fact and moves
 * nothing (D228 stands — there is no switcher).
 */
const MEMBERSHIPS_SQL = `
  SELECT o.id AS org_id, o.name AS org_name, m.role, m."createdAt" AS joined_at
    FROM "member" m
    JOIN "organization" o ON o.id = m."organizationId"
   WHERE m."userId" = $1
   ORDER BY m."createdAt", m.id`;

export async function listMemberships(userId: string, query: QueryRows): Promise<Membership[]> {
  const rows = await query<{ org_id: string; org_name: string; role: string; joined_at: Date }>(
    MEMBERSHIPS_SQL,
    [userId],
  );
  return rows.map((row) => ({
    orgId: row.org_id,
    orgName: row.org_name,
    role: row.role,
    joinedAt: new Date(row.joined_at),
  }));
}
