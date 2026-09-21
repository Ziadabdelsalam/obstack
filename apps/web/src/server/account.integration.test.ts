import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { accountErrorCode } from "@/app/app/account/errors";
import { getAuth, signUpWithWorkspace } from "./auth";
import {
  EmailTaken,
  UnknownSession,
  changePassword,
  changeSignInEmail,
  listMemberships,
  listOwnSessions,
  parseSessionId,
  readAccount,
  revokeOtherOwnSessions,
  revokeOwnSession,
  updateDisplayName,
} from "./account";
import { acceptInvite, createInvite } from "./invites";
import { getPool, queryRows } from "./postgres";

// run with: the compose Postgres (or any postgres:17.11 with pgmigrations
//           applied — see auth.integration.test.ts's header for the throwaway
//           recipe), then
//   OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//     npm test --workspace apps/web
//
// The account surface against real rows (D707–D711): a name and an address
// change through the library in-process and read back through the session; a
// taken address is detected where the library stays silent; a password change
// really rotates what signs in and leaves THIS session's row alone; the
// session statements really list only the account's own rows, never a token,
// and a revoked cookie really is dead on its next read; and a membership added
// by accepting an invitation is listed as a fact beside the owned org.
//
// D130's skip class: it skips ONLY when OBSTACK_TEST_POSTGRES_DSN is unset, and
// it genuinely dials, so a DSN pointing at a dead port fails loudly here.

const TEST_DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;

// lazy by design (D114), so these assignments cannot lose a race with the imports
if (TEST_DSN) process.env.OBSTACK_POSTGRES_DSN = TEST_DSN;

/** A dummy, for sessions that live in a throwaway database (D112(b)). */
process.env.BETTER_AUTH_SECRET = "RTh7qKp2wZ9xN4vB6mJ0sL8dF3gY1cA5eU7iO9rTq2w=";

/** D119: BETTER_AUTH_URL is set in NO environment — removed, not merely unset. */
delete process.env.BETTER_AUTH_URL;

/**
 * The literal `auth.integration.test.ts` excludes from its whole-table counts —
 * its SECOND named sibling, beside the invites file's `inv-it-`. That file
 * snapshots the seven auth tables around each refused POST and node runs test
 * files in PARALLEL, so a row this file writes between two snapshots would read
 * there as a leak. EVERY row this file creates is reachable from a user whose
 * email carries this prefix — including the addresses the email tests change
 * TO — and the first test asserts that of its own fixtures rather than
 * trusting it. Nothing here writes `verification`, which that file counts
 * whole and unexcluded; the D709 test asserts that too.
 */
const PREFIX = "acct-it";

const RUN = randomBytes(4).toString("hex");
const PASSWORD = `${PREFIX}-${RUN}-password`;

/**
 * D36 class: the ONLY reason this file may skip. `web.yml` exports the DSN and
 * fails the job on an unexpected skip, so in CI this branch is unreachable.
 */
function noPostgres(t: TestContext): boolean {
  if (TEST_DSN) return false;
  t.skip(
    "OBSTACK_TEST_POSTGRES_DSN is unset; start a postgres:17.11 with the pgmigrations applied to run this test",
  );
  return true;
}

type Stranger = {
  label: string;
  name: string;
  email: string;
  userId: string;
  orgId: string;
  workspaceId: string;
  /** A real browser-shaped session: the cookie better-auth's own sign-in minted. */
  headers: Headers;
  sessionId: string;
};

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

/**
 * Sign in as an existing account and hand back the cookie as headers — what a
 * server action does with `await headers()` — plus the session row it opened.
 * The cookie is minted by the library's own sign-in for the reason
 * `auth.integration.test.ts` records: signup's cookie is written through
 * `next/headers`, which `nextCookies()` skips outside a request scope.
 */
async function signIn(email: string, password = PASSWORD): Promise<{ headers: Headers; sessionId: string }> {
  const response = await getAuth().api.signInEmail({ body: { email, password }, asResponse: true });
  assert.equal(response.status, 200, `sign-in for ${email} failed`);
  const setCookie = String(response.headers.get("set-cookie"));
  assert.match(setCookie, /^better-auth\.session_token=/);
  const headers = new Headers({ cookie: setCookie.split(";")[0] });
  const account = await readAccount(headers);
  assert.ok(account, "the cookie the sign-in minted does not resolve to an account");
  return { headers, sessionId: account.sessionId };
}

/** A stranger who really signed up, with a real session. */
async function signUpStranger(label: string): Promise<Stranger> {
  const name = `${PREFIX}-${RUN} ${label}`;
  const email = `${PREFIX}-${RUN}-${label}@obstack.invalid`;
  const { orgId, workspaceId } = await signUpWithWorkspace({ name, email, password: PASSWORD });
  createdOrgIds.push(orgId);
  const [user] = await queryRows<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);
  createdUserIds.push(user.id);
  const session = await signIn(email);
  return { label, name, email, userId: user.id, orgId, workspaceId, ...session };
}

const userRow = async (userId: string) =>
  (await queryRows<{ name: string; email: string }>(`SELECT name, email FROM "user" WHERE id = $1`, [userId]))[0];

const sessionIds = async (userId: string) =>
  (await queryRows<{ id: string }>(`SELECT id FROM "session" WHERE "userId" = $1 ORDER BY id`, [userId])).map(
    (row) => row.id,
  );

after(async () => {
  if (!TEST_DSN) return;
  // orgs first: `workspaces.org_id` is a soft reference (D112), so nothing
  // cascades to it. Deleting the user then takes its sessions, accounts,
  // memberships and invitations with it through the captured schema. Users are
  // deleted by ID, because this file changes the addresses it signed up with.
  for (const orgId of createdOrgIds) {
    await queryRows(`DELETE FROM workspaces WHERE org_id = $1`, [orgId]);
    await queryRows(`DELETE FROM "organization" WHERE id = $1`, [orgId]);
  }
  for (const userId of createdUserIds) {
    await queryRows(`DELETE FROM "user" WHERE id = $1`, [userId]);
  }
  await getPool().end();
});

// ---- D707: who is signed in ------------------------------------------------

test("D707: the account behind a session is the row signup wrote, on a session id the parse admits", async (t) => {
  if (noPostgres(t)) return;
  const alice = await signUpStranger("alice");

  // the sibling agreement, asserted rather than trusted (see PREFIX)
  for (const spelling of [alice.name, alice.email]) {
    assert.ok(spelling.includes(`${PREFIX}-`), `a fixture spelling lost the sibling literal: ${spelling}`);
  }

  const account = await readAccount(alice.headers);
  assert.ok(account);
  assert.equal(account.userId, alice.userId);
  assert.equal(account.email, alice.email);
  assert.equal(account.name, alice.name);
  // a REAL session id, against the regex the unit test pins on a fixture
  assert.equal(parseSessionId(account.sessionId), account.sessionId);
  assert.equal(account.sessionId, alice.sessionId);
  // no cookie, no account — the page's redirect to /login rests on this null
  assert.equal(await readAccount(new Headers()), null);
});

// ---- D708: the name, through the library, in-process ----------------------

test("D708: the name changes through /update-user in-process, and the session reads it back", async (t) => {
  if (noPostgres(t)) return;
  const alice = await signUpStranger("rename");

  await updateDisplayName(`${PREFIX}-${RUN} renamed`, alice.headers);

  assert.equal((await userRow(alice.userId)).name, `${PREFIX}-${RUN} renamed`);
  assert.equal((await readAccount(alice.headers))?.name, `${PREFIX}-${RUN} renamed`);
});

// ---- D709: the sign-in address -------------------------------------------

test("D709: the address changes, lower-cased, and is what signs in next; a taken address is named, not swallowed", async (t) => {
  if (noPostgres(t)) return;
  const alice = await signUpStranger("email");
  const bob = await signUpStranger("emailbob");
  const [{ n: verificationBefore }] = await queryRows<{ n: string }>(`SELECT count(*)::text AS n FROM "verification"`);

  const mixedCase = `${PREFIX}-${RUN}-Email-New@Obstack.invalid`;
  await changeSignInEmail(alice.userId, mixedCase, alice.headers, queryRows);

  await t.test("the row holds the lower-cased address and the session sees it", async () => {
    assert.equal((await userRow(alice.userId)).email, mixedCase.toLowerCase());
    assert.equal((await readAccount(alice.headers))?.email, mixedCase.toLowerCase());
  });

  await t.test("the new address signs in and the old one no longer does", async () => {
    await signIn(mixedCase.toLowerCase());
    await assert.rejects(
      getAuth().api.signInEmail({ body: { email: alice.email, password: PASSWORD } }),
      (error: unknown) => (error as { body?: { code?: string } }).body?.code === "INVALID_EMAIL_OR_PASSWORD",
    );
  });

  await t.test("an address another account holds is refused as EmailTaken, and the row is unchanged", async () => {
    // The library answers `{ status: true }` here and changes nothing
    // (`routes/update-user.mjs`, "Change email attempt for existing email") —
    // this is the answer `changeSignInEmail` reads the row back to correct.
    await assert.rejects(
      changeSignInEmail(alice.userId, bob.email, alice.headers, queryRows),
      (error: unknown) => {
        assert.ok(error instanceof EmailTaken);
        assert.equal(accountErrorCode(error), "email-taken");
        return true;
      },
    );
    assert.equal((await userRow(alice.userId)).email, mixedCase.toLowerCase());
    assert.equal((await userRow(bob.userId)).email, bob.email, "the other account's row must not move either");
  });

  await t.test("the address already on the account is the library's codeless refusal, mapped", async () => {
    await assert.rejects(
      changeSignInEmail(alice.userId, mixedCase.toLowerCase(), alice.headers, queryRows),
      (error: unknown) => {
        assert.equal(accountErrorCode(error), "email-same");
        return true;
      },
    );
  });

  await t.test("a malformed address is the body schema's refusal, mapped — measured against the real call", async () => {
    await assert.rejects(
      changeSignInEmail(alice.userId, "not-an-address", alice.headers, queryRows),
      (error: unknown) => {
        assert.equal(accountErrorCode(error), "email-invalid");
        return true;
      },
    );
  });

  // Nothing above wrote a verification row: `createEmailVerificationToken`
  // signs a JWT and never touches the table (`routes/email-verification.mjs`).
  // `auth.integration.test.ts` counts that table whole, so this is what keeps
  // the two files from measuring each other.
  const [{ n: verificationAfter }] = await queryRows<{ n: string }>(`SELECT count(*)::text AS n FROM "verification"`);
  assert.equal(verificationAfter, verificationBefore, "an email change wrote a verification row");
});

// ---- D710: the password ----------------------------------------------------

test("D710: a password change rotates what signs in, refuses a wrong current one, and leaves this session's row alone", async (t) => {
  if (noPostgres(t)) return;
  const carol = await signUpStranger("password");
  const NEW_PASSWORD = `${PASSWORD}-rotated`;
  const rowBefore = (
    await queryRows<{ ipAddress: string | null; userAgent: string | null }>(
      `SELECT "ipAddress", "userAgent" FROM "session" WHERE id = $1`,
      [carol.sessionId],
    )
  )[0];

  await t.test("a wrong current password is INVALID_PASSWORD, mapped, and changes nothing", async () => {
    await assert.rejects(
      changePassword({ currentPassword: `${PASSWORD}-wrong`, newPassword: NEW_PASSWORD }, carol.headers),
      (error: unknown) => {
        assert.equal(accountErrorCode(error), "password-incorrect");
        return true;
      },
    );
    await signIn(carol.email, PASSWORD);
  });

  await t.test("a new password under the documented floor is PASSWORD_TOO_SHORT, mapped", async () => {
    await assert.rejects(
      changePassword({ currentPassword: PASSWORD, newPassword: "short" }, carol.headers),
      (error: unknown) => {
        assert.equal(accountErrorCode(error), "password-short");
        return true;
      },
    );
  });

  await changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, carol.headers);

  await t.test("the old password no longer signs in and the new one does", async () => {
    await assert.rejects(
      getAuth().api.signInEmail({ body: { email: carol.email, password: PASSWORD } }),
      (error: unknown) => (error as { body?: { code?: string } }).body?.code === "INVALID_EMAIL_OR_PASSWORD",
    );
    await signIn(carol.email, NEW_PASSWORD);
  });

  await t.test("the session the change ran on is intact, with the address and agent it was opened with", async () => {
    // `revokeOtherSessions: false` in `changePassword` is what keeps this row:
    // the library's own revoke would delete it and re-create it bare.
    assert.equal((await readAccount(carol.headers))?.sessionId, carol.sessionId);
    const rowAfter = (
      await queryRows<{ ipAddress: string | null; userAgent: string | null }>(
        `SELECT "ipAddress", "userAgent" FROM "session" WHERE id = $1`,
        [carol.sessionId],
      )
    )[0];
    assert.deepEqual(rowAfter, rowBefore);
  });
});

// ---- D711: sessions, listed and ended by id --------------------------------

test("D711: the list is the account's own live rows and never a token; a revoke is judged by owner, id and currency", async (t) => {
  if (noPostgres(t)) return;
  const dave = await signUpStranger("sessions");
  const other = await signUpStranger("sessionsother");
  // MEASURED on the first CI run of this file: a stranger who has just signed
  // up already holds TWO sessions, not one. `signUpEmail` opens a session of
  // its own and tries to set its cookie; outside a request scope the cookie
  // write is swallowed (`auth.integration.test.ts`'s `realSessionCookie`
  // note) but the ROW stays, so `signIn` adds a second one beside it. In the
  // product the two are one — signup's cookie reaches the browser — but here
  // the baseline is read off the store rather than assumed, and every claim
  // below is stated against it.
  const daveAtSignup = await sessionIds(dave.userId);
  const otherAtSignup = await sessionIds(other.userId);
  assert.ok(daveAtSignup.includes(dave.sessionId));
  const second = await signIn(dave.email);
  const third = await signIn(dave.email);
  const own = [...daveAtSignup, second.sessionId, third.sessionId].sort();

  await t.test("the list holds exactly the account's rows, token-free, newest first", async () => {
    const sessions = await listOwnSessions(dave.userId, queryRows);
    assert.deepEqual(sessions.map((s) => s.id).sort(), own);
    for (const session of sessions) {
      assert.deepEqual(
        Object.keys(session).sort(),
        ["createdAt", "expiresAt", "id", "ipAddress", "userAgent"],
        "a session row reached the caller with a column the list must not carry",
      );
      assert.ok(session.expiresAt.getTime() > Date.now());
      assert.equal(parseSessionId(session.id), session.id);
    }
    // an in-process sign-in carries no request, so the row holds no address
    // and no agent — NULLIF makes that null rather than an empty string
    assert.equal(sessions[0].ipAddress, null);
    assert.equal(sessions[0].userAgent, null);
    // the other account's session is nowhere in it
    assert.ok(!sessions.some((s) => s.id === other.sessionId));
  });

  await t.test("another account's session id is UnknownSession, and that row survives", async () => {
    await assert.rejects(
      revokeOwnSession(dave.userId, other.sessionId, dave.sessionId, queryRows),
      (error: unknown) => error instanceof UnknownSession,
    );
    assert.deepEqual(await sessionIds(other.userId), otherAtSignup);
    assert.ok(await readAccount(other.headers), "the other account's cookie must still resolve");
  });

  await t.test("the current session is refused by the predicate, not by the page", async () => {
    await assert.rejects(
      revokeOwnSession(dave.userId, dave.sessionId, dave.sessionId, queryRows),
      (error: unknown) => error instanceof UnknownSession,
    );
    assert.ok((await sessionIds(dave.userId)).includes(dave.sessionId));
  });

  await t.test("a revoked session's cookie is dead on its next read", async () => {
    await revokeOwnSession(dave.userId, second.sessionId, dave.sessionId, queryRows);
    assert.deepEqual(await sessionIds(dave.userId), own.filter((id) => id !== second.sessionId));
    assert.equal(await readAccount(second.headers), null, "the revoked cookie still resolves — the store is not the authority");
    assert.ok(await readAccount(third.headers));
  });

  await t.test("revoking the others ends every row but this one, and answers how many", async () => {
    // everything but the current row: the third sign-in plus whatever signup
    // left behind (the measured baseline above, minus the current row)
    const others = own.filter((id) => id !== second.sessionId && id !== dave.sessionId);
    assert.equal(await revokeOtherOwnSessions(dave.userId, dave.sessionId, queryRows), others.length);
    assert.deepEqual(await sessionIds(dave.userId), [dave.sessionId]);
    assert.equal(await readAccount(third.headers), null);
    assert.equal((await readAccount(dave.headers))?.sessionId, dave.sessionId);
    // nothing else's rows moved
    assert.deepEqual(await sessionIds(other.userId), otherAtSignup);
  });
});

// ---- memberships: a fact beside the owned org -------------------------------

test("memberships list the owned org first and an accepted invitation second, roles as the rows hold them", async (t) => {
  if (noPostgres(t)) return;
  const erin = await signUpStranger("member");
  const frank = await signUpStranger("inviter");

  assert.deepEqual(
    (await listMemberships(erin.userId, queryRows)).map((m) => [m.orgId, m.orgName, m.role]),
    [[erin.orgId, erin.name, "owner"]],
    "signup leaves exactly one membership, and it is the owner one",
  );

  // frank invites erin into HIS org; erin accepts (the S3.2 lifecycle, in-process)
  const invite = await createInvite(frank.orgId, erin.email, frank.headers);
  await acceptInvite(invite.id, erin.headers);

  const memberships = await listMemberships(erin.userId, queryRows);
  assert.deepEqual(
    memberships.map((m) => [m.orgId, m.orgName, m.role]),
    [
      [erin.orgId, erin.name, "owner"],
      [frank.orgId, frank.name, "member"],
    ],
  );
  assert.ok(memberships[0].joinedAt.getTime() <= memberships[1].joinedAt.getTime());
});
