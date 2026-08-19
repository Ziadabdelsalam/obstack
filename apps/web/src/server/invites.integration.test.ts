import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { GET, POST } from "@/app/api/auth/[...all]/route";
import { inviteErrorCode } from "@/app/invite/[id]/errors";
import { getAuth, signUpWithWorkspace } from "./auth";
import {
  acceptInvite,
  cancelInvite,
  createInvite,
  findJoinedOrgName,
  getInviteForRecipient,
  getOrgName,
  inviteLinkPath,
  listOrgMembers,
  listPendingInvites,
  parseInvitationId,
} from "./invites";
import { getPool, queryRows } from "./postgres";
import { resolveSessionContext } from "./session";

// run with: the compose Postgres (or any postgres:17.11 with pgmigrations
//           applied — see auth.integration.test.ts's header for the throwaway
//           recipe), then
//   OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//     npm test --workspace apps/web
//
// D143's whole verdict, against real rows: invitations work end to end while
// EVERY invitation endpoint stays a 404 to the network, and accepting one is
// ADDITIVE — it adds a membership and moves nobody's session.
//
// The additive property is the one that needs live ammunition rather than an
// assertion, because better-auth really does write the invitee's session row
// `activeOrganizationId` to the INVITING org (measured, crud-invites.mjs:330).
// This file proves both halves on the same rows: that column really moves, and
// the product's resolution really does not follow it — with the two resolutions
// that WOULD follow it run side by side, answering with the inviter's workspace.
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

/** D119's canonical app origin — `localhost`, never `127.0.0.1`. */
const ORIGIN = "http://localhost:3000";
const at = (path: string) => `${ORIGIN}/api/auth${path}`;

/**
 * The literal `auth.integration.test.ts` excludes from its whole-table counts.
 * That file is the suite's other writer of the better-auth tables and node runs
 * test files in PARALLEL, so its snapshots would otherwise measure this one.
 * EVERY row this file creates is reachable from a user whose email carries this
 * prefix, and the first test asserts exactly that rather than trusting it.
 */
const PREFIX = "inv-it";

const RUN = randomBytes(4).toString("hex");
const PASSWORD = `${PREFIX}-${RUN}-password`;

/** This run's rows, for the row-delta snapshots below. */
const RUN_ROWS = `%${PREFIX}-${RUN}%`;

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

/**
 * Counts scoped to THIS run, not whole tables: the sibling integration file
 * writes the same tables concurrently, so a whole-table count here would measure
 * that file and not the endpoint under test. What keeps the scoping honest is
 * the falsification test at the bottom — it fires the same refused bodies with
 * the guard bypassed and these very counts must move.
 */
const RUN_USERS = `(SELECT id FROM "user" WHERE email LIKE $1)`;

const ROW_COUNTS_SQL = `SELECT
  (SELECT count(*)::int FROM "user" WHERE email LIKE $1) AS "user",
  (SELECT count(*)::int FROM "session" WHERE "userId" IN ${RUN_USERS}) AS "session",
  (SELECT count(*)::int FROM "account" WHERE "userId" IN ${RUN_USERS}) AS "account",
  (SELECT count(*)::int FROM "organization" WHERE name LIKE $1) AS "organization",
  (SELECT count(*)::int FROM "member" WHERE "userId" IN ${RUN_USERS}) AS "member",
  (SELECT count(*)::int FROM "invitation" WHERE "inviterId" IN ${RUN_USERS}) AS "invitation",
  (SELECT count(*)::int
     FROM workspaces w
     JOIN "organization" o ON o.id = w.org_id
    WHERE o.name LIKE $1) AS "workspaces"`;

async function rowCounts(): Promise<Record<string, number>> {
  const [row] = await queryRows<Record<string, number>>(ROW_COUNTS_SQL, [RUN_ROWS]);
  return row;
}

type Stranger = {
  label: string;
  name: string;
  email: string;
  userId: string;
  orgId: string;
  workspaceId: string;
  headers: Headers;
};

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

/**
 * A stranger who really signed up, with a real browser-shaped session.
 *
 * The cookie is minted by better-auth's own sign-in rather than read off the
 * signup call, for the reason `auth.integration.test.ts` records: signup's
 * cookie is written through `next/headers`, which `nextCookies()` skips outside
 * a request scope. Every invite call below is handed these headers, which is
 * exactly what a server action does with `await headers()`.
 */
async function signUpStranger(label: string): Promise<Stranger> {
  const name = `${PREFIX}-${RUN} ${label}`;
  const email = `${PREFIX}-${RUN}-${label}@obstack.invalid`;
  createdEmails.push(email);
  const { orgId, workspaceId } = await signUpWithWorkspace({ name, email, password: PASSWORD });
  createdOrgIds.push(orgId);
  const [user] = await queryRows<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);

  const response = await getAuth().api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  assert.equal(response.status, 200, `sign-in for ${label} failed`);
  const setCookie = String(response.headers.get("set-cookie"));
  assert.match(setCookie, /^better-auth\.session_token=/);

  return {
    label,
    name,
    email,
    userId: user.id,
    orgId,
    workspaceId,
    headers: new Headers({ cookie: setCookie.split(";")[0] }),
  };
}

/** Bob's session rows, whole, so "what acceptance wrote" can be a diff and not a claim. */
const SESSION_ROWS_SQL = `
  SELECT id, token, "userId", "activeOrganizationId", "expiresAt", "createdAt"
    FROM "session" WHERE "userId" = $1 ORDER BY id`;

type SessionRow = {
  id: string;
  token: string;
  userId: string;
  activeOrganizationId: string | null;
  expiresAt: Date;
  createdAt: Date;
};

const sessionRows = (userId: string) => queryRows<SessionRow>(SESSION_ROWS_SQL, [userId]);

/**
 * `resolveSessionContext`'s query with the owner pin REPLACED by better-auth's
 * `activeOrganizationId` — the resolution D143 says must never be written. It is
 * here as live ammunition: on the rows below it answers with the INVITER's
 * workspace, which is what makes the real resolution answering with the
 * invitee's own a fact about the pin rather than about a fixture.
 */
const HONOURING_ACTIVE_ORG_SQL = `
  SELECT s."activeOrganizationId" AS org_id, w.id AS workspace_id
    FROM "session" s
    JOIN workspaces w ON w.org_id = s."activeOrganizationId"
   WHERE s."userId" = $1
   ORDER BY w.created_at, w.id
   LIMIT 1`;

/** The same query with the `role = 'owner'` pin dropped — D120's other falsification. */
const NO_OWNER_PIN_SQL = `
  SELECT m."organizationId" AS org_id, w.id AS workspace_id
    FROM "member" m
    JOIN workspaces w ON w.org_id = m."organizationId"
   WHERE m."userId" = $1
   ORDER BY w.created_at, w.id
   LIMIT 1`;

after(async () => {
  if (!TEST_DSN) return;
  // orgs first: `workspaces.org_id` is a soft reference (D112), so nothing
  // cascades to it. Deleting the user then takes its sessions, accounts,
  // memberships and invitations with it through the captured schema.
  for (const orgId of createdOrgIds) {
    await queryRows(`DELETE FROM workspaces WHERE org_id = $1`, [orgId]);
    await queryRows(`DELETE FROM "organization" WHERE id = $1`, [orgId]);
  }
  for (const email of createdEmails) {
    await queryRows(`DELETE FROM "user" WHERE email = $1`, [email]);
  }
  await getPool().end();
});

// ---- D143: the lifecycle, entirely through server-side auth.api.* ----------

test("D143: invite, list, accept and cancel all run server-side with ZERO doors open", async (t) => {
  if (noPostgres(t)) return;

  const alice = await signUpStranger("owner");
  const bob = await signUpStranger("invitee");

  // the sibling file's exclusion literal is a shared agreement, asserted here
  for (const stranger of [alice, bob]) {
    assert.ok(stranger.email.includes(`${PREFIX}-`), "a fixture email escaped the sibling prefix");
    assert.ok(stranger.name.includes(`${PREFIX}-`), "a fixture org name escaped the sibling prefix");
  }

  const invite = await createInvite(alice.orgId, bob.email, alice.headers);

  await t.test("the invitation id is an opaque token the parse accepts", () => {
    // measured against the running library rather than believed: 1.7.1 generates
    // 32 characters of [a-zA-Z0-9], which is the domain `parseInvitationId` pins
    assert.match(invite.id, /^[A-Za-z0-9]{32}$/);
    assert.equal(parseInvitationId(invite.id), invite.id);
    assert.equal(inviteLinkPath(invite.id), `/invite/${invite.id}`);
  });

  await t.test("the invitation is addressed to the teammate and pending in the owner's org", async () => {
    assert.equal(invite.email, bob.email);
    assert.ok(invite.expiresAt.getTime() > Date.now(), "a fresh invitation must not be expired");
    // MEASURED default expiry: 48h (crud-invites.mjs:137, adapter.mjs:730). The
    // window is asserted loosely because it is the library's number, not ours —
    // what matters is that a link handed to a person lasts longer than a click.
    assert.ok(invite.expiresAt.getTime() > Date.now() + 47 * 3600 * 1000);

    assert.deepEqual(
      (await listPendingInvites(alice.orgId, alice.headers)).map((i) => [i.id, i.email]),
      [[invite.id, bob.email]],
    );
    // the org id came from the owner pin, and the row agrees
    assert.deepEqual(
      await queryRows(`SELECT "organizationId", status, role FROM "invitation" WHERE id = $1`, [
        invite.id,
      ]),
      [{ organizationId: alice.orgId, status: "pending", role: "member" }],
    );
  });

  await t.test("the recipient — and only the recipient — can read it", async () => {
    const view = await getInviteForRecipient(invite.id, bob.headers);
    assert.equal(view.id, invite.id);
    assert.equal(view.organizationName, alice.name);

    // MEASURED (crud-invites.mjs:269/504): acceptance and reading are gated on
    // the signed-in email matching the invited one, case-insensitively. The
    // inviter is not the recipient, so even SHE cannot read her own invite.
    const carol = await signUpStranger("stranger");
    await assert.rejects(getInviteForRecipient(invite.id, carol.headers), (error: unknown) => {
      assert.equal(inviteErrorCode(error), "not-recipient");
      return true;
    });
    await assert.rejects(acceptInvite(invite.id, carol.headers), (error: unknown) => {
      assert.equal(inviteErrorCode(error), "not-recipient");
      return true;
    });
    assert.equal(await findJoinedOrgName(invite.id, carol.userId, carol.email, queryRows), null);
  });

  await t.test("an id that never existed is 'not found', through both endpoints", async () => {
    const ghost = "z".repeat(32);
    // the codeless-message arm and the coded arm, on the SAME situation — both
    // spellings measured here rather than hand-built (auth.test.ts pins them)
    await assert.rejects(getInviteForRecipient(ghost, bob.headers), (error: unknown) => {
      assert.equal(inviteErrorCode(error), "not-found");
      return true;
    });
    await assert.rejects(acceptInvite(ghost, bob.headers), (error: unknown) => {
      assert.equal(inviteErrorCode(error), "not-found");
      return true;
    });
  });

  await t.test("the emailVerified guard does not fire — verification is OFF (D143 escalation check)", async () => {
    // The absence is falsified rather than assumed (S2.2 L1): the guard's input
    // is asserted false AND the two endpoints it guards are shown to work.
    // `shouldRequireVerifiedEmailForInvitationIdAction` (crud-invites.mjs:30-36)
    // returns false because `authConfig()` sets neither `advanced.generateId` nor
    // `advanced.database.generateId`; if that ever changes, the reads above start
    // raising EMAIL_VERIFICATION_REQUIRED_* and this test names why.
    assert.deepEqual(
      await queryRows(`SELECT "emailVerified" FROM "user" WHERE id = $1`, [bob.userId]),
      [{ emailVerified: false }],
      "the fixture must have an UNVERIFIED email for this to be a probe",
    );
  });

  // ---- the cancel half, and the owner pin on it (D148) ----

  await t.test("cancel refuses an invitation that is not this org's", async () => {
    const outsider = await signUpStranger("outsider");
    await assert.rejects(
      cancelInvite(outsider.orgId, invite.id, outsider.headers),
      /does not belong to this workspace/,
      "an invitation id from another org must not be cancellable through our action",
    );
    assert.deepEqual(
      await queryRows(`SELECT status FROM "invitation" WHERE id = $1`, [invite.id]),
      [{ status: "pending" }],
      "the refused cancel must not have reached the library",
    );

    const doomed = await createInvite(alice.orgId, `${PREFIX}-${RUN}-cancelled@obstack.invalid`, alice.headers);
    await cancelInvite(alice.orgId, doomed.id, alice.headers);
    assert.deepEqual(
      await queryRows(`SELECT status FROM "invitation" WHERE id = $1`, [doomed.id]),
      [{ status: "canceled" }],
    );
    // a cancelled invitation is no longer pending, and its link is dead
    assert.deepEqual(
      (await listPendingInvites(alice.orgId, alice.headers)).map((i) => i.id),
      [invite.id],
    );
  });
});

// ---- D143: acceptance is ADDITIVE, never a re-home -------------------------

test("D143: accepting adds a membership, moves activeOrganizationId, and moves NO session", async (t) => {
  if (noPostgres(t)) return;

  const alice = await signUpStranger("re-home-owner");
  const bob = await signUpStranger("re-home-invitee");

  // Live ammunition, made deterministic: with the inviter's workspace strictly
  // OLDER, both falsification queries below answer with HERS. Without this the
  // two signups' timestamps decide, and a green run could mean the fixture never
  // could have gone wrong.
  await queryRows(`UPDATE workspaces SET created_at = now() - interval '1 day' WHERE id = $1`, [
    alice.workspaceId,
  ]);

  const invite = await createInvite(alice.orgId, bob.email, alice.headers);

  const before = await rowCounts();
  const sessionsBefore = await sessionRows(bob.userId);
  assert.ok(sessionsBefore.length > 0, "the invitee must hold a real session for this to be a probe");
  assert.deepEqual(
    sessionsBefore.map((row) => row.activeOrganizationId),
    sessionsBefore.map(() => null),
    "no session may carry an active org before the accept",
  );

  await acceptInvite(invite.id, bob.headers);

  const after = await rowCounts();
  const sessionsAfter = await sessionRows(bob.userId);

  await t.test("acceptance writes a member row and NOTHING else (D143 escalation check)", () => {
    // The third escalation condition, as a diff: acceptance may write the member
    // row, the invitation's status and the session's activeOrganizationId, and
    // if it ever writes a fourth thing that is a ruling to revisit, not an
    // adaptation. `invitation` counts rows, and a status change is not one.
    assert.deepEqual(after, { ...before, member: before.member + 1 });
  });

  await t.test("the invitation is accepted, and no longer pending anywhere", async () => {
    assert.deepEqual(
      await queryRows(`SELECT status FROM "invitation" WHERE id = $1`, [invite.id]),
      [{ status: "accepted" }],
    );
    assert.deepEqual(await listPendingInvites(alice.orgId, alice.headers), []);
  });

  await t.test("the invitee's session row really is moved to the inviting org (MEASURED)", () => {
    // crud-invites.mjs:330 → adapter.mjs:397 → internalAdapter.updateSession.
    // This is the fact the whole ruling rests on: it is TRUE, and it is inert.
    assert.deepEqual(
      sessionsAfter.map((row) => row.id),
      sessionsBefore.map((row) => row.id),
      "acceptance created or destroyed a session row",
    );
    const moved = sessionsAfter.filter((row) => row.activeOrganizationId !== null);
    assert.equal(moved.length, 1, "exactly the session that accepted must carry an active org");
    assert.equal(moved[0].activeOrganizationId, alice.orgId);
    // ...and nothing else on any session row changed
    for (const [i, row] of sessionsAfter.entries()) {
      assert.equal(row.token, sessionsBefore[i].token);
      assert.equal(row.userId, sessionsBefore[i].userId);
      assert.equal(row.expiresAt.getTime(), sessionsBefore[i].expiresAt.getTime());
      assert.equal(row.createdAt.getTime(), sessionsBefore[i].createdAt.getTime());
    }
  });

  await t.test("membership is ADDITIVE: owner of his own org, member of hers", async () => {
    assert.deepEqual(
      await queryRows(
        `SELECT "organizationId", role FROM "member" WHERE "userId" = $1 ORDER BY role`,
        [bob.userId],
      ),
      [
        { organizationId: alice.orgId, role: "member" },
        { organizationId: bob.orgId, role: "owner" },
      ],
    );
    // and the inviter's Members tab shows him, by content
    const members = await listOrgMembers(alice.orgId, queryRows);
    assert.deepEqual(
      members.map((m) => [m.email, m.role]),
      [
        [alice.email, "owner"],
        [bob.email, "member"],
      ],
    );
  });

  await t.test("resolution still answers with the invitee's OWN workspace (S3.1 L1, by content)", async () => {
    // Content-aware, not shape-aware: the two workspace ids are asserted to be
    // different real values FIRST, so "returned his own" cannot be green because
    // both sides happen to be the same string or an empty one.
    assert.notEqual(alice.workspaceId, bob.workspaceId);
    assert.ok(alice.workspaceId.length > 0 && bob.workspaceId.length > 0);

    assert.deepEqual(await resolveSessionContext(bob.userId, queryRows), {
      userId: bob.userId,
      orgId: bob.orgId,
      workspaceId: bob.workspaceId,
    });
    // the inviter is untouched in both directions
    assert.deepEqual(await resolveSessionContext(alice.userId, queryRows), {
      userId: alice.userId,
      orgId: alice.orgId,
      workspaceId: alice.workspaceId,
    });
  });

  await t.test("falsification: the two resolutions that WOULD re-home answer with the inviter's workspace", async () => {
    // Without these, the assertion above would read the same on rows where
    // nothing could have gone wrong. Each is a one-clause edit away from the
    // real query in `session.ts` — honour `activeOrganizationId`, or drop the
    // `role = 'owner'` pin — and each hands the invitee somebody else's data.
    assert.deepEqual(
      await queryRows(HONOURING_ACTIVE_ORG_SQL, [bob.userId]),
      [{ org_id: alice.orgId, workspace_id: alice.workspaceId }],
      "honouring activeOrganizationId does not re-home here — the fixture is not live ammunition",
    );
    assert.deepEqual(
      await queryRows(NO_OWNER_PIN_SQL, [bob.userId]),
      [{ org_id: alice.orgId, workspace_id: alice.workspaceId }],
      "dropping the owner pin does not re-home here — the fixture is not live ammunition",
    );
  });

  await t.test("the accept surface can still name the org he joined", async () => {
    // better-auth serves PENDING invitations only, so the joined state is a read
    // of our own rows — scoped to the asking user's membership and email, which
    // is why the stranger above got null from the same call.
    assert.equal(
      await findJoinedOrgName(invite.id, bob.userId, bob.email, queryRows),
      alice.name,
    );
    assert.equal(
      await findJoinedOrgName(invite.id, bob.userId, bob.email.toUpperCase(), queryRows),
      alice.name,
      "the email match is case-insensitive, as better-auth's own recipient check is",
    );
    assert.equal(await findJoinedOrgName(invite.id, alice.userId, alice.email, queryRows), null);
    // D158's reader, on the same rows: the settings heading's name, and null for
    // an org that has no row — the case its caller turns into a loud throw.
    assert.equal(await getOrgName(alice.orgId, queryRows), alice.name);
    assert.equal(await getOrgName("org_nope", queryRows), null);
  });

  await t.test("accepting twice is 'not found', not a second membership", async () => {
    await assert.rejects(acceptInvite(invite.id, bob.headers), (error: unknown) => {
      assert.equal(inviteErrorCode(error), "not-found");
      return true;
    });
    assert.deepEqual(await rowCounts(), after);
  });
});

// ---- D143: the five doors stay closed, with a REAL invitation in hand ------

test("D143: every invitation endpoint answers 404 to a real session holding a real invitation", async (t) => {
  if (noPostgres(t)) return;

  const alice = await signUpStranger("doors-owner");
  const bob = await signUpStranger("doors-invitee");
  const invite = await createInvite(alice.orgId, bob.email, alice.headers);
  const cookie = String(bob.headers.get("cookie"));

  /**
   * Live ammunition: the exact bodies these endpoints want, with a REAL pending
   * invitation id and a REAL organization id. The falsification test below fires
   * two of them with the guard bypassed and watches rows appear.
   */
  const body = JSON.stringify({
    invitationId: invite.id,
    organizationId: alice.orgId,
    email: `${PREFIX}-${RUN}-door@obstack.invalid`,
    role: "member",
  });

  const DOORS = [
    "/organization/accept-invitation",
    "/organization/cancel-invitation",
    "/organization/get-invitation",
    "/organization/invite-member",
    "/organization/list-invitations",
  ];
  assert.equal(DOORS.length, 5, "D143 names exactly five invitation endpoints");

  for (const path of DOORS) {
    const before = await rowCounts();
    const posted = await POST(
      new Request(at(path), {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
        body,
      }),
    );
    // read as text: with the guard removed better-auth answers some of these
    // itself, and a `.json()` that threw would hide which door opened
    const postBody = await posted.text();
    assert.equal(posted.status, 404, `${path} was not refused — status ${posted.status}`);
    assert.match(postBody, /sign up at \/signup/i, `${path} answered 404 from somewhere else`);

    // GET too, because two of the five are GET endpoints and a guard that only
    // covered POST would leave the invitation readable to anyone holding an id
    const got = await GET(
      new Request(`${at(path)}?id=${invite.id}&organizationId=${alice.orgId}`, {
        headers: { cookie },
      }),
    );
    assert.equal(got.status, 404, `GET ${path} was not refused`);
    assert.match(await got.text(), /sign up at \/signup/i);

    assert.deepEqual(await rowCounts(), before, `${path} changed rows — a refused endpoint wrote`);
  }

  // and the invitation is exactly as it was: still pending, still unaccepted
  assert.deepEqual(
    await queryRows(`SELECT status FROM "invitation" WHERE id = $1`, [invite.id]),
    [{ status: "pending" }],
  );
});

test("D143 falsification: the same bodies, with the guard bypassed, really do write rows", async (t) => {
  if (noPostgres(t)) return;

  // Without this, the matrix above would read the same on requests that could
  // never have done anything. Removing the allowlist check from `route.ts` IS
  // this request path, so this is that red run, standing.
  const alice = await signUpStranger("bypass-owner");
  const bob = await signUpStranger("bypass-invitee");
  const aliceCookie = String(alice.headers.get("cookie"));
  const bobCookie = String(bob.headers.get("cookie"));

  const before = await rowCounts();

  const invited = await getAuth().handler(
    new Request(at("/organization/invite-member"), {
      method: "POST",
      headers: { cookie: aliceCookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: bob.email, role: "member", organizationId: alice.orgId }),
    }),
  );
  assert.equal(invited.status, 200, "the matrix's invite body is not live ammunition");
  const invitation = (await invited.json()) as { id: string };

  const afterInvite = await rowCounts();
  assert.equal(
    afterInvite.invitation,
    before.invitation + 1,
    "no invitation row appeared with the guard bypassed",
  );

  const accepted = await getAuth().handler(
    new Request(at("/organization/accept-invitation"), {
      method: "POST",
      headers: { cookie: bobCookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ invitationId: invitation.id }),
    }),
  );
  assert.equal(accepted.status, 200, "the matrix's accept body is not live ammunition");

  const afterAccept = await rowCounts();
  assert.equal(
    afterAccept.member,
    afterInvite.member + 1,
    "no membership appeared with the guard bypassed",
  );
  // ...and the hazard that made this a door worth closing: the raw endpoint
  // moved the invitee's session onto the inviter's org, exactly as our own
  // server-side call does — which is why closing the door is about WHO may
  // supply the organizationId, not about what acceptance does.
  const moved = (await sessionRows(bob.userId)).filter((row) => row.activeOrganizationId !== null);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].activeOrganizationId, alice.orgId);
  assert.deepEqual(await resolveSessionContext(bob.userId, queryRows), {
    userId: bob.userId,
    orgId: bob.orgId,
    workspaceId: bob.workspaceId,
  });
});
