import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { GET, POST } from "@/app/api/auth/[...all]/route";
import { SignupError, getAuth, signUpWithWorkspace } from "./auth";
import { getPool, queryRows } from "./postgres";
import { resolveSessionContext } from "./session";

// run with: docker run --rm -d --name obstack-f4-pg -p 127.0.0.1:55436:5432 \
//             -e POSTGRES_USER=obstack -e POSTGRES_PASSWORD=obstack_postgres_dev \
//             -e POSTGRES_DB=obstack postgres:17.11
//           for f in services/ingest/pgmigrations/*.sql; do \
//             docker exec -i obstack-f4-pg psql -v ON_ERROR_STOP=1 -U obstack -d obstack < "$f"; done
// then:     OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:55436/obstack \
//             npm test --workspace apps/web
// (in CI the DSN points at the compose Postgres the job already boots — ingest's
// boot migrator is the one schema path, D130(4).)
//
// The real-Postgres half of the auth verifications (D130(2)+(3)). `auth.test.ts`
// and `session.test.ts` prove the same three contracts against fake clients and
// must keep running on a machine with no Postgres at all (D114 byte-invariance,
// ratified untouched by D130(1)); what a fake client cannot prove is that the
// SQL is real SQL — that the transaction really rolls back, that the captured
// schema's ON DELETE CASCADE really follows the compensating delete, and that a
// refused endpoint really writes no row. That is this file.
//
// It skips ONLY when `OBSTACK_TEST_POSTGRES_DSN` is unset, and it genuinely
// dials: a DSN pointing at a dead port fails loudly here rather than skipping,
// which is the whole difference between this and a guard that can go quietly
// green (D130(2)).

const TEST_DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;

// `postgres.ts` reads OBSTACK_POSTGRES_DSN on its first query and `auth.ts`
// reads BETTER_AUTH_SECRET when the auth instance is first used — both lazy by
// design (D114), so these assignments cannot lose a race with the imports above.
if (TEST_DSN) process.env.OBSTACK_POSTGRES_DSN = TEST_DSN;

/**
 * This process's fixing value for the secret. It is a dummy: the sessions it
 * signs live in a throwaway database for the length of one run. D112(b) keeps
 * BETTER_AUTH_SECRET out of compose and the chart — a web process (this one
 * included) is the only thing that ever sets it.
 */
process.env.BETTER_AUTH_SECRET = "RTh7qKp2wZ9xN4vB6mJ0sL8dF3gY1cA5eU7iO9rTq2w=";

/**
 * D119: BETTER_AUTH_URL is set in NO local or CI environment — better-auth
 * derives the origin from the request, and setting an http:// value downgrades
 * the production cookie name. Removed rather than merely not set, so an
 * inherited value cannot make this file's sessions differ from the app's.
 */
delete process.env.BETTER_AUTH_URL;

/** D119's canonical app origin — `localhost`, never `127.0.0.1`. */
const ORIGIN = "http://localhost:3000";
const at = (path: string) => `${ORIGIN}/api/auth${path}`;

/** Everything this run creates carries this token, so cleanup can name its own rows. */
const RUN = randomBytes(4).toString("hex");
const PASSWORD = `f4-it-${RUN}-password`;

/**
 * D36 class: the ONLY reason this file may skip. `web.yml` exports the DSN and
 * fails the job on an unexpected skip, so in CI this branch is unreachable and
 * every test below executes on every PR.
 */
function noPostgres(t: TestContext): boolean {
  if (TEST_DSN) return false;
  t.skip(
    "OBSTACK_TEST_POSTGRES_DSN is unset; start a postgres:17.11 with the pgmigrations applied (see the header) to run this test",
  );
  return true;
}

/**
 * The captured schema's tables, all of them (D128's count set). The names are
 * file-local literals interpolated as IDENTIFIERS, which is the one thing a
 * parameter cannot be; every VALUE below is bound as `$1`/`$2`, here and
 * everywhere else (D11).
 */
const AUTH_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "organization",
  "member",
  "invitation",
];

/**
 * The sibling writers, NAMED. `invites.integration.test.ts` (S3.2) signs
 * strangers up and invites them, and `account.integration.test.ts` (D707)
 * signs strangers up, renames them, changes their addresses and opens and ends
 * their sessions — between them they write six of the seven tables below — and
 * node runs test files in PARALLEL (measured), with every file taking its DSN
 * from the same variable. Every row either file creates is reachable from a
 * user whose email carries its literal, and each asserts that of its own
 * fixtures, so the spellings are one agreement rather than three hopes.
 *
 * The agreement has a second half, and it is the one that keeps tier (i) below
 * from going blind: nothing THIS file writes — not its fixtures and not the rows
 * a leak would create out of `leakBody` — may carry either literal, or the
 * matrix would stop counting exactly the door that opened. That is asserted at
 * the top of the matrix test rather than reasoned about here.
 *
 * `verification` is the one table with no exclusion: neither sibling writes it
 * (the account file asserts so around its email changes), so it stays counted
 * whole.
 */
const SIBLING_LITERALS = ["inv-it-", "acct-it-"] as const;
/** Bound as `$2` and `$3`, in this order, everywhere the counts run. */
const SIBLING_ROWS = SIBLING_LITERALS.map((literal) => `%${literal}%`);

/**
 * How each table is counted, as its own predicate. The set is deliberately
 * TIERED (D131), and no tier is a simplification waiting to be made:
 *
 * (i) the seven auth tables are counted WHOLE except for the sibling file's
 * rows — narrowing them to this run's rows would let a leak that wrote somebody
 * ELSE'S row read as green, so the exclusion is by the named files that also
 * write them and by nothing else. Before S3.2 this file was the suite's only
 * writer and the counts were plain; the `NOT LIKE`s are exactly the price of
 * gaining a second one (and a third, D707), and they are written as a
 * JOIN-free subquery on `user` so the excluded set is "rows belonging to those
 * files' strangers", not "rows that happen to spell something".
 *
 * (ii) `workspaces` is counted by this RUN's rows — widening it back to whole
 * re-imports a second writer, because `saved-views.integration.test.ts` writes
 * and deletes workspaces of its own, and a whole-table count there measures that
 * file and not the endpoint under test (measured: 2 spurious reds in 22 suite
 * runs; 0 in 15 after scoping).
 *
 * What closes the hole any narrowing could in theory leave is the composite, not
 * the clause on its own: no better-auth table references `workspaces` (D112 —
 * soft `org_id`, no cross-set FK) and better-auth's SQL has never heard of the
 * table, so a leak cannot reach a workspace without first moving one of the
 * seven — which is exactly what the falsification test at the bottom of this
 * file fires the matrix's own body to demonstrate, watching `organization` and
 * `member` move under a bypassed guard.
 */
const SIBLING_USERS = `(SELECT id FROM "user" WHERE email LIKE $2 OR email LIKE $3)`;

const AUTH_TABLE_COUNTS: Record<string, string> = {
  user: `(SELECT count(*)::int FROM "user" WHERE email NOT LIKE $2 AND email NOT LIKE $3)`,
  session: `(SELECT count(*)::int FROM "session" WHERE "userId" NOT IN ${SIBLING_USERS})`,
  account: `(SELECT count(*)::int FROM "account" WHERE "userId" NOT IN ${SIBLING_USERS})`,
  verification: `(SELECT count(*)::int FROM "verification")`,
  organization: `(SELECT count(*)::int FROM "organization" WHERE name NOT LIKE $2 AND name NOT LIKE $3)`,
  member: `(SELECT count(*)::int FROM "member" WHERE "userId" NOT IN ${SIBLING_USERS})`,
  invitation: `(SELECT count(*)::int FROM "invitation"
                 WHERE email NOT LIKE $2 AND email NOT LIKE $3 AND "inviterId" NOT IN ${SIBLING_USERS})`,
};

/** All eight counts in ONE statement, so a snapshot is internally consistent. */
const ROW_COUNTS_SQL = `SELECT
  ${AUTH_TABLES.map((name) => `${AUTH_TABLE_COUNTS[name]} AS "${name}"`).join(",\n  ")},
  (SELECT count(*)::int
     FROM workspaces w
     JOIN "organization" o ON o.id = w.org_id
    WHERE o.name LIKE $1) AS "workspaces"`;

/** Every org this run creates — its own and the ones a leak would create — is named after the run. */
const RUN_ORGS = `%${RUN}%`;

async function rowCounts(): Promise<Record<string, number>> {
  const [row] = await queryRows<Record<string, number>>(ROW_COUNTS_SQL, [RUN_ORGS, ...SIBLING_ROWS]);
  return row;
}

const createdEmails: string[] = [];
const createdOrgIds: string[] = [];

/** A stranger who really signed up: the product's own signup path, against real rows. */
async function signUpStranger(label: string): Promise<{
  name: string;
  email: string;
  userId: string;
  orgId: string;
  workspaceId: string;
}> {
  const name = `Stranger ${label} ${RUN}`;
  const email = `f4-it-${RUN}-${label}@obstack.invalid`;
  createdEmails.push(email);
  const { orgId, workspaceId } = await signUpWithWorkspace({ name, email, password: PASSWORD });
  createdOrgIds.push(orgId);
  const [user] = await queryRows<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);
  return { name, email, userId: user.id, orgId, workspaceId };
}

after(async () => {
  if (!TEST_DSN) return;
  // orgs first: `workspaces.org_id` is a soft reference (D112), so nothing
  // cascades to it. Deleting the user then takes its sessions, accounts and
  // memberships with it through the captured schema.
  for (const orgId of createdOrgIds) {
    await queryRows(`DELETE FROM workspaces WHERE org_id = $1`, [orgId]);
    await queryRows(`DELETE FROM "organization" WHERE id = $1`, [orgId]);
  }
  for (const email of createdEmails) {
    await queryRows(`DELETE FROM "user" WHERE email = $1`, [email]);
  }
  await getPool().end();
});

// ---- D117: the signup contract, as rows ------------------------------------

test("D117 success: one signup writes the user, the org, an owner membership and one workspace", async (t) => {
  if (noPostgres(t)) return;

  const stranger = await signUpStranger("success");

  assert.deepEqual(
    await queryRows(`SELECT email FROM "user" WHERE email = $1`, [stranger.email]),
    [{ email: stranger.email }],
  );
  assert.deepEqual(
    await queryRows(`SELECT "organizationId", role FROM "member" WHERE "userId" = $1`, [
      stranger.userId,
    ]),
    [{ organizationId: stranger.orgId, role: "owner" }],
    "signup must leave exactly one membership, and it must be an owner one (the pin D120 resolves through)",
  );
  // the org's slug is its id — `organization.slug` is UNIQUE in the captured
  // schema, so a slug derived from a name would let one stranger's signup fail
  // because another picked the same word first
  assert.deepEqual(
    await queryRows(`SELECT id, slug FROM "organization" WHERE id = $1`, [stranger.orgId]),
    [{ id: stranger.orgId, slug: stranger.orgId }],
  );
  assert.deepEqual(
    await queryRows(`SELECT id, org_id FROM workspaces WHERE org_id = $1`, [stranger.orgId]),
    [{ id: stranger.workspaceId, org_id: stranger.orgId }],
    "an org gets exactly one workspace at signup (org→workspaces 1:N, D95)",
  );

  // the three rows are a session context, resolved by the product's own query
  assert.deepEqual(await resolveSessionContext(stranger.userId, queryRows), {
    userId: stranger.userId,
    orgId: stranger.orgId,
    workspaceId: stranger.workspaceId,
  });
});

/** The org name of the one signup the trigger below refuses — nothing else's. */
const HALF_STATE_ORG = `f4 half-state probe ${RUN}`;

/**
 * A trigger that refuses the workspace INSERT of exactly ONE signup — the one
 * whose org is named above. A blanket `CHECK (false)` on `workspaces` would do
 * the same job and also refuse every other writer's inserts for as long as it is
 * installed; this file shares its database with whatever else the suite runs in
 * parallel, so the refusal is scoped to its own probe. The trigger's SELECT runs
 * inside the signup's own transaction, which is why it can see the org row that
 * transaction has not committed yet.
 *
 * The prefix is spelled in the function body rather than bound: a plpgsql body
 * is source text, not a statement, so it has no `$1` to bind to. It is this
 * file's own constant and nothing a row or a caller supplies — the run suffix,
 * which IS computed, stays out of it.
 */
async function refuseHalfStateWorkspaceInsert(): Promise<() => Promise<void>> {
  await queryRows(`
    CREATE FUNCTION f4_refuse_workspace() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM "organization" o
         WHERE o.id = NEW.org_id AND o.name LIKE 'f4 half-state probe%'
      ) THEN
        RAISE EXCEPTION 'f4 probe: workspace INSERT refused';
      END IF;
      RETURN NEW;
    END
    $fn$`);
  await queryRows(
    `CREATE TRIGGER f4_refuse_workspace_trg BEFORE INSERT ON workspaces
       FOR EACH ROW EXECUTE FUNCTION f4_refuse_workspace()`,
  );
  return async () => {
    await queryRows(`DROP TRIGGER IF EXISTS f4_refuse_workspace_trg ON workspaces`);
    await queryRows(`DROP FUNCTION IF EXISTS f4_refuse_workspace()`);
  };
}

test("D117 failure: a workspace INSERT that really fails leaves ZERO rows behind", async (t) => {
  if (noPostgres(t)) return;

  const name = HALF_STATE_ORG;
  const email = `f4-it-${RUN}-halfstate@obstack.invalid`;
  createdEmails.push(email);
  const restore = await refuseHalfStateWorkspaceInsert();

  try {
    const before = await rowCounts();

    await assert.rejects(
      signUpWithWorkspace({ name, email, password: PASSWORD }),
      (error: unknown) => {
        assert.ok(error instanceof SignupError, "the caller must see a signup failure, not a pg error");
        assert.match(String((error as Error).cause), /workspace INSERT refused/);
        return true;
      },
    );

    // The whole property in one assertion: no user (the compensating delete), no
    // session or account (the captured schema's ON DELETE CASCADE), no org and no
    // member (the ROLLBACK), no workspace (the statement that failed).
    assert.deepEqual(
      await rowCounts(),
      before,
      "a failed signup left rows behind — there is no half-signed-up stranger state (D117)",
    );
    assert.deepEqual(
      await queryRows(`SELECT id FROM "user" WHERE email = $1`, [email]),
      [],
      "better-auth's user row survived a failed signup — the compensating delete did not run",
    );
  } finally {
    await restore();
  }

  // Control (S2.2 L1): the refusal was the trigger, not a fixture that could
  // never have signed up. Re-running the SAME email also proves the user really
  // went away — a survivor would come back USER_ALREADY_EXISTS.
  const { orgId, workspaceId } = await signUpWithWorkspace({ name, email, password: PASSWORD });
  createdOrgIds.push(orgId);
  assert.deepEqual(
    await queryRows(`SELECT id FROM workspaces WHERE org_id = $1`, [orgId]),
    [{ id: workspaceId }],
  );
});

// ---- D120: the owner pin, against a user who really is in two orgs ----------

/**
 * `ACTIVE_WORKSPACE_SQL` as it read BEFORE D120 — the same statement without
 * `AND m.role = 'owner'`. It exists to prove the fixture below is live
 * ammunition: on these rows the pre-D120 query answers with the FOREIGN
 * workspace, so the real query answering with the user's own is a fact about
 * the pin and not about a fixture that never sorted first.
 */
const PRE_D120_SQL = `
  SELECT m."organizationId" AS org_id, w.id AS workspace_id
    FROM "member" m
    JOIN workspaces w ON w.org_id = m."organizationId"
   WHERE m."userId" = $1
   ORDER BY w.created_at, w.id
   LIMIT 1`;

test("D120 owner pin: a member-role row in a second org with an OLDER workspace does not move the session", async (t) => {
  if (noPostgres(t)) return;

  const stranger = await signUpStranger("ownerpin");

  // Someone else's org, made before this stranger existed, with this stranger
  // in it as a plain member — the shape S3.2's invitations produce, and the
  // shape any org endpoint that stopped being refused would produce today.
  const foreignOrgId = `org_f4_foreign_${RUN}`;
  const foreignWorkspaceId = `ws_f4_foreign_${RUN}`;
  createdOrgIds.push(foreignOrgId);
  await queryRows(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, $2, $1, now())`, [
    foreignOrgId,
    `Someone Else ${RUN}`,
  ]);
  await queryRows(
    `INSERT INTO workspaces (id, org_id, created_at) VALUES ($1, $2, now() - interval '1 day')`,
    [foreignWorkspaceId, foreignOrgId],
  );
  await queryRows(
    `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'member', now())`,
    [`mem_f4_foreign_${RUN}`, foreignOrgId, stranger.userId],
  );

  await t.test("the session stays on the org the stranger OWNS", async () => {
    assert.deepEqual(await resolveSessionContext(stranger.userId, queryRows), {
      userId: stranger.userId,
      orgId: stranger.orgId,
      workspaceId: stranger.workspaceId,
    });
  });

  await t.test("falsification: without the pin, this same fixture resolves to the foreign workspace", async () => {
    assert.deepEqual(
      await queryRows(PRE_D120_SQL, [stranger.userId]),
      [{ org_id: foreignOrgId, workspace_id: foreignWorkspaceId }],
      "the older foreign workspace does not sort first — the pin above is green by construction",
    );
  });

  await t.test("a second workspace in the stranger's own org does not become the active one", async () => {
    // D114: active = `ORDER BY created_at, id LIMIT 1`, no active_workspace
    // column and no switcher. The id sorts BEFORE the signup workspace's, so a
    // resolution that lost `created_at` from the ordering answers with this one.
    const laterWorkspaceId = `ws_0000000000000000${RUN}`;
    await queryRows(
      `INSERT INTO workspaces (id, org_id, created_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [laterWorkspaceId, stranger.orgId],
    );
    // asked of Postgres, not of JavaScript: it is Postgres' collation that the
    // ORDER BY under test sorts by
    const [order] = await queryRows<{ sorts_first: boolean }>(
      `SELECT ($1::text < $2::text) AS sorts_first`,
      [laterWorkspaceId, stranger.workspaceId],
    );
    assert.ok(order.sorts_first, "the fixture must sort first by id to be a probe");
    assert.equal(
      (await resolveSessionContext(stranger.userId, queryRows)).workspaceId,
      stranger.workspaceId,
    );
  });
});

// ---- D128: the row-delta matrix, driven by a real session ------------------

/**
 * The mounted surface, DERIVED from the auth instance this process built rather
 * than pinned — `auth.test.ts` cannot derive it (building an instance is the
 * thing it must prove never happens with no secret present), so its 52-entry
 * fixture and this enumeration are two independent measurements of the same
 * surface. `:param` segments are filled with a literal, as they are there.
 */
function mountedEndpoints(): string[] {
  const api = getAuth().api as unknown as Record<string, { path?: string } | undefined>;
  const paths = Object.values(api)
    .map((endpoint) => endpoint?.path)
    .filter((path): path is string => typeof path === "string")
    .map((path) => path.replace(/:\w+/g, "f4param"));
  return [...new Set(paths)].sort();
}

/** The only two doors D120 leaves open. */
const ALLOWED = ["/get-session", "/sign-out"];

/**
 * A body carrying, in one object, what each refused endpoint would need to do
 * its damage: an org to create, an org to delete, a member to promote, an
 * account to sign up. It is live ammunition — the falsification test at the
 * bottom fires the same body through better-auth with the guard bypassed and
 * watches it write rows.
 */
function leakBody(
  path: string,
  session: { email: string; userId: string; orgId: string },
): string {
  const slug = `f4-leak-${RUN}-${path.replace(/\W+/g, "-")}`;
  return JSON.stringify({
    name: `f4 leak ${slug}`,
    slug,
    organizationId: session.orgId,
    organizationSlug: slug,
    userId: session.userId,
    memberIdOrEmail: session.email,
    role: "owner",
    email: `f4-it-${RUN}-leak@obstack.invalid`,
    newEmail: `f4-it-${RUN}-leak@obstack.invalid`,
    password: PASSWORD,
    newPassword: `${PASSWORD}-new`,
    currentPassword: PASSWORD,
    callbackURL: "/app",
  });
}

/**
 * A real browser-shaped session for an account the signup path really created.
 *
 * The cookie is minted by better-auth's own sign-in rather than read off the
 * signup call because signup's cookie is written through `next/headers`, which
 * `nextCookies()` skips outside a request scope (measured: its after-hook
 * swallows "`cookies` was called outside a request scope."). The session it
 * returns is the same shape and the same store; `/get-session` — one of D120's
 * two open doors — is asked to confirm it before the matrix trusts it.
 */
async function realSessionCookie(email: string): Promise<string> {
  const response = await getAuth().api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  assert.equal(response.status, 200, "sign-in for the matrix's own account failed");
  const setCookie = response.headers.get("set-cookie");
  // Unprefixed here because this Request is plain http; a production serve at
  // localhost sets `__Secure-better-auth.session_token` (D119) — same cookie,
  // named by the transport.
  assert.match(String(setCookie), /^better-auth\.session_token=/);
  return String(setCookie).split(";")[0];
}

test("D128: every refused endpoint answers 404 to a REAL session and moves no row", async (t) => {
  if (noPostgres(t)) return;

  const stranger = await signUpStranger("matrix");
  const cookie = await realSessionCookie(stranger.email);

  await t.test("this file's own rows are rows the counts still count", () => {
    // The sibling exclusion's other half (S2.2 L1: an absence claim gets a
    // probe). Every column tier (i) excludes on — `user.email`,
    // `organization.name`, `invitation.email` — is written here from one of
    // these two fixture spellings or from `leakBody`, so if none of them can
    // carry the literal, no row a leak writes can hide behind it.
    for (const spelling of [stranger.name, stranger.email]) {
      for (const literal of SIBLING_LITERALS) {
        assert.ok(
          !spelling.includes(literal),
          `a fixture spelling carries the sibling literal ${literal} and would go uncounted: ${spelling}`,
        );
      }
    }
  });

  await t.test("the session driving the matrix is real — the open door says so", async () => {
    const response = await GET(new Request(at("/get-session"), { headers: { cookie } }));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { user?: { id?: string } };
    assert.equal(body.user?.id, stranger.userId);
  });

  const mounted = mountedEndpoints();
  // S2.0 L1: a loop over a shrunken surface is green by vacuity. This number is
  // measured from the running library, so unlike `auth.test.ts`'s pin it moves
  // on its own the moment better-auth mounts a door — which is exactly when
  // someone must look.
  assert.equal(
    mounted.length,
    52,
    "the mounted better-auth surface changed size — re-check the allowlist and auth.test.ts's fixture against it",
  );
  for (const allowed of ALLOWED) {
    assert.ok(mounted.includes(allowed), `${allowed} is not mounted — the allowlist opens a door that is gone`);
  }

  const refused = mounted.filter((path) => !ALLOWED.includes(path));
  assert.equal(refused.length, 50);

  for (const path of refused) {
    const leak = leakBody(path, stranger);
    for (const literal of SIBLING_LITERALS) {
      assert.ok(
        !leak.includes(literal),
        `the leak body for ${path} carries the sibling literal ${literal} — a row it wrote would go uncounted`,
      );
    }
    const before = await rowCounts();
    const response = await POST(
      new Request(at(path), {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
        body: leak,
      }),
    );
    // read as text, not JSON: with the guard removed better-auth answers some of
    // these 404 itself, with an empty body, and a `.json()` that throws would
    // report a parse error instead of naming the door that opened
    const body = await response.text();
    assert.equal(response.status, 404, `${path} was not refused — status ${response.status}`);
    assert.match(
      body,
      /sign up at \/signup/i,
      `${path} answered 404 from somewhere other than the allowlist: ${JSON.stringify(body.slice(0, 120))}`,
    );
    assert.deepEqual(
      await rowCounts(),
      before,
      `POST ${path} changed rows — a refused endpoint reached the store`,
    );
  }
});

test("D128 falsification: the same request, with the guard bypassed, really does write rows", async (t) => {
  if (noPostgres(t)) return;

  // Without this, the matrix above would read the same on a request that could
  // never have done anything — 50 harmless POSTs answering 404 and touching no
  // row prove nothing about the guard. Removing the allowlist check from
  // `route.ts` is exactly this request path, so this is that red run, standing.
  const stranger = await signUpStranger("bypass");
  const cookie = await realSessionCookie(stranger.email);
  const path = "/organization/create";

  const before = await rowCounts();
  const response = await getAuth().handler(
    new Request(at(path), {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: leakBody(path, stranger),
    }),
  );

  assert.equal(response.status, 200, "the matrix's body is not live ammunition for organization/create");
  const created = (await response.json()) as { id: string };
  const after = await rowCounts();

  try {
    assert.equal(after.organization, before.organization + 1, "no org row appeared with the guard bypassed");
    assert.equal(after.member, before.member + 1, "no membership appeared with the guard bypassed");
    // and the D120 hazard itself: the new org has no workspace, so a session
    // that ever resolved through it would resolve to nothing
    assert.deepEqual(await queryRows(`SELECT id FROM workspaces WHERE org_id = $1`, [created.id]), []);
  } finally {
    await queryRows(`DELETE FROM "organization" WHERE id = $1`, [created.id]);
  }
});
