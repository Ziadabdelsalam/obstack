import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APIError } from "better-auth";
import { GET, POST } from "@/app/api/auth/[...all]/route";
import { HOSTILE_URL_VALUES } from "@/lib/hostile-url-values";
import {
  LOGIN_ERRORS,
  loginErrorCode,
  loginErrorMessage,
  type LoginErrorCode,
} from "@/app/login/errors";
import {
  SIGNUP_ERRORS,
  signupErrorCode,
  signupErrorMessage,
  type SignupErrorCode,
} from "@/app/signup/errors";
import {
  INVITE_ERRORS,
  inviteErrorCode,
  inviteErrorMessage,
  type InviteErrorCode,
} from "@/app/invite/[id]/errors";
import { inviteLinkPath, parseInvitationId } from "./invites";
import { SignupError, provisionOrgAndWorkspace } from "./auth";
import { RateLimitedError } from "./rate-limit";
import type { SqlClient } from "./postgres";

/**
 * The auth SURFACE this repo owns, all of it, with no server anywhere: the
 * signup transaction (D117), the mounted-endpoint allowlist (D120) and the
 * `?error=` vocabulary (D121).
 *
 * These two variables are deleted rather than merely left unset, and that is
 * load-bearing for the D120 matrix below: `authConfig()` throws without them, so
 * ANY code path that reached better-auth would surface as a rejection instead of
 * a 404. A refused endpoint answering 404 is therefore proof that nothing
 * downstream ran — which is what "zero row deltas" means when there is no row
 * store to count.
 */
delete process.env.BETTER_AUTH_SECRET;
delete process.env.OBSTACK_POSTGRES_DSN;

// run with: npm test --workspace apps/web
//
// D117's signup contract is a PROPERTY, not a sequence: success means the user,
// the org and the workspace all exist, and any failure past the user leaves
// none of them. The user leg is better-auth's own INSERT, so these tests take
// the user id as given and prove the half this repo owns — the transaction and
// the compensation — against a client that fails exactly where told. The full
// three-row property was also measured against a real postgres:17.11 (T3's
// report): a NOT VALID check constraint on `workspaces` made the workspace
// INSERT impossible, and the row counts before and after the refused signup
// were identical.
//
// No Postgres is needed here on purpose: this file must pass on a machine that
// has none (D114's byte-invariance, and `web`'s skip trap allows no skips).

type Statement = { sql: string; params?: unknown[] };

/**
 * A client that records what it was asked to run and refuses the first
 * statement matching `failOn` — the only way to make a real transaction fail
 * at a chosen point.
 */
function recordingClient(failOn?: RegExp) {
  const statements: Statement[] = [];
  const client: SqlClient = {
    async query(sql: string, params?: unknown[]) {
      statements.push({ sql, params });
      if (failOn?.test(sql)) throw new Error(`postgres refused: ${sql}`);
      return { rows: [] };
    },
  };
  return { client, statements };
}

const sqlAt = (statements: Statement[], i: number) => statements[i].sql;
const table = (sql: string) => sql.match(/INSERT INTO "?(\w+)"?/)?.[1];

test("success writes org, member and workspace inside one committed transaction", async () => {
  const { client, statements } = recordingClient();
  const removed: string[] = [];

  const { orgId, workspaceId } = await provisionOrgAndWorkspace(
    client,
    "user-1",
    "Stranger One",
    async (id) => void removed.push(id),
  );

  assert.deepEqual(
    statements.map((s) => table(s.sql) ?? s.sql),
    ["BEGIN", "organization", "member", "workspaces", "COMMIT"],
  );
  assert.equal(statements.some((s) => s.sql === "ROLLBACK"), false);
  assert.deepEqual(removed, [], "a successful signup must not remove its own user");

  // the org owns the workspace (org→workspaces 1:N, soft org_id per D112)
  assert.deepEqual(statements[1].params, [orgId, "Stranger One"]);
  assert.deepEqual(statements[2].params?.slice(1), [orgId, "user-1"]);
  assert.deepEqual(statements[3].params, [workspaceId, orgId]);
  assert.notEqual(orgId, workspaceId);

  // `organization.slug` is UNIQUE in the captured schema (0003_auth.sql), so it
  // is filled from $1 — the org id — and never from a name or an email local
  // part, which would make one stranger's signup fail because another picked
  // the same word first.
  assert.match(sqlAt(statements, 1), /VALUES \(\$1, \$2, \$1, now\(\)\)/);
});

test("a refused workspace INSERT rolls the transaction back and removes the user", async () => {
  const { client, statements } = recordingClient(/INSERT INTO workspaces/);
  const removed: string[] = [];

  await assert.rejects(
    provisionOrgAndWorkspace(client, "user-2", "Stranger Two", async (id) => void removed.push(id)),
    (error: unknown) => {
      assert.ok(error instanceof SignupError, "the caller must see a signup failure, not a pg error");
      assert.match((error as Error).message, /org and workspace could not be created/);
      return true;
    },
  );

  assert.equal(sqlAt(statements, statements.length - 1), "ROLLBACK");
  assert.equal(statements.some((s) => s.sql === "COMMIT"), false, "nothing may be committed");
  assert.deepEqual(removed, ["user-2"], "the user this signup created must not survive it");
});

test("a refused org INSERT fails the same way — the property is not about the last statement", async () => {
  const { client, statements } = recordingClient(/INSERT INTO "organization"/);
  const removed: string[] = [];

  await assert.rejects(
    provisionOrgAndWorkspace(client, "user-3", "Stranger Three", async (id) => void removed.push(id)),
    SignupError,
  );
  assert.deepEqual(
    statements.map((s) => table(s.sql) ?? s.sql),
    ["BEGIN", "organization", "ROLLBACK"],
  );
  assert.deepEqual(removed, ["user-3"]);
});

test("a compensation that fails is louder, not quieter", async () => {
  const { client } = recordingClient(/INSERT INTO workspaces/);
  const cleanupError = new Error("connection lost");

  await assert.rejects(
    provisionOrgAndWorkspace(client, "user-4", "Stranger Four", async () => {
      throw cleanupError;
    }),
    (error: unknown) => {
      assert.ok(error instanceof SignupError);
      // the surviving user is named, because someone has to go delete it
      assert.match((error as Error).message, /user-4/);
      assert.equal((error as Error).cause, cleanupError);
      return true;
    },
  );
});

// ---- D120: the mounted-endpoint allowlist, over the whole measured surface ----

const ORIGIN = "http://localhost:3000";
const at = (path: string) => `${ORIGIN}/api/auth${path}`;

/**
 * A session cookie shaped like the real one. It is deliberately not a valid
 * session, and that is the point: the guard runs before the handler exists, so
 * a refusal cannot depend on who is asking. The live counterpart — a REAL
 * session against a real Postgres, with row counts taken before and after each
 * refused mutation — is recorded in the F1 report.
 */
const SESSION = { cookie: "better-auth.session_token=eyJz.notarealtoken" };

/**
 * The thirteen org-plugin mutations — the reviewer's matrix, named one by one
 * because each is a specific tenancy break: `create` makes an org with no
 * workspace (a session that resolves to nothing), `accept-invitation` and
 * `set-active` move a user onto another org's workspace, `delete` and
 * `remove-member` orphan the workspace a session is already resolving through.
 */
const ORG_MUTATIONS = [
  "/organization/accept-invitation",
  "/organization/cancel-invitation",
  "/organization/check-slug",
  "/organization/create",
  "/organization/delete",
  "/organization/has-permission",
  "/organization/invite-member",
  "/organization/leave",
  "/organization/reject-invitation",
  "/organization/remove-member",
  "/organization/set-active",
  "/organization/update",
  "/organization/update-member-role",
];

/**
 * Every path better-auth 1.7.1 mounts under this segment, measured from
 * `getAuth().api` (each entry's `.path`) with this exact config; `:param`
 * segments are filled with a literal. Pinned as a fixture rather than derived at
 * runtime because deriving it needs an auth instance, and building one is the
 * very thing the matrix must prove never happens.
 *
 * Which means this fixture cannot notice a library that grew: its length and the
 * number below are two literals in one file and they always agree. The version
 * pin asserted alongside them is the actual re-measure trigger — an upgrade has
 * to edit `apps/web/package.json`, and editing it turns this test red.
 */
const MOUNTED_ENDPOINTS = [
  "/account-info",
  "/callback/google",
  "/change-email",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
  "/error",
  "/get-access-token",
  "/get-session",
  "/link-social",
  "/list-accounts",
  "/list-sessions",
  "/ok",
  "/organization/get-active-member",
  "/organization/get-active-member-role",
  "/organization/get-full-organization",
  "/organization/get-invitation",
  "/organization/get-organization",
  "/organization/list",
  "/organization/list-invitations",
  "/organization/list-members",
  "/organization/list-user-invitations",
  ...ORG_MUTATIONS,
  "/refresh-token",
  "/request-password-reset",
  "/reset-password",
  "/reset-password/sometoken",
  "/revoke-other-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/send-verification-email",
  "/sign-in/email",
  "/sign-in/social",
  "/sign-out",
  "/sign-up/email",
  "/unlink-account",
  "/update-session",
  "/update-user",
  "/verify-email",
  "/verify-password",
];

/** The only two doors D120 leaves open. */
const ALLOWED = ["/get-session", "/sign-out"];

/**
 * D143's named STAY-CLOSED entries: the five invitation endpoints S3.2 actually
 * uses. Naming them is the point. They are already inside the fifty the loop
 * above refuses, so this list adds no coverage the matrix lacks — what it adds
 * is a place where opening one of them for a browser has to be a deliberate
 * edit to a list that says, in words, that it must not be.
 *
 * `server/invites.ts` reaches all five through `auth.api.*` in-process, filling
 * `organizationId` from the session's owner pin rather than from a body. That is
 * why the product can invite, cancel and accept while every one of these paths
 * stays a 404 to the network.
 */
const INVITE_ENDPOINTS = [
  "/organization/accept-invitation",
  "/organization/cancel-invitation",
  "/organization/get-invitation",
  "/organization/invite-member",
  "/organization/list-invitations",
];

/** The version the surface above was measured against (D117's exact pin). */
const BETTER_AUTH_MEASURED_AT = "1.7.1";

const installedBetterAuth = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  }
).dependencies["better-auth"];

async function refusal(response: Response) {
  assert.equal(response.status, 404);
  const body = (await response.json()) as { message?: string };
  assert.match(String(body.message), /sign up at \/signup/i);
}

test("D120: every mounted endpoint except get-session and sign-out is refused, by both verbs", async () => {
  // S2.0 L1: a loop over a shrunken fixture is green by vacuity, so the surface
  // is pinned before anything iterates. 52 was measured at better-auth 1.7.1,
  // and the version is pinned first because it is the only thing here that a
  // library upgrade changes on its own.
  assert.equal(
    installedBetterAuth,
    BETTER_AUTH_MEASURED_AT,
    "better-auth moved: re-measure the mounted surface from getAuth().api (each entry's .path), update MOUNTED_ENDPOINTS and its count, then move this pin",
  );
  assert.equal(
    MOUNTED_ENDPOINTS.length,
    52,
    "the mounted better-auth surface changed size — re-measure it from getAuth().api before touching this number",
  );
  assert.equal(ORG_MUTATIONS.length, 13);

  const refused = MOUNTED_ENDPOINTS.filter((path) => !ALLOWED.includes(path));
  assert.equal(refused.length, 50);

  for (const path of refused) {
    await refusal(await POST(new Request(at(path), { method: "POST", headers: SESSION })));
    await refusal(await GET(new Request(at(path), { headers: SESSION })));
  }
});

test("D120: the org-plugin mutations are refused with a session attached and touch nothing", async () => {
  for (const path of ORG_MUTATIONS) {
    const response = await POST(
      new Request(at(path), {
        method: "POST",
        headers: { ...SESSION, "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org_someone_else", name: "x", slug: "x" }),
      }),
    );
    await refusal(response);
  }
});

test("D143: the five invitation endpoints are mounted, refused, and refused with an invite body", async () => {
  assert.equal(INVITE_ENDPOINTS.length, 5, "D143 names exactly five invitation endpoints");
  for (const path of INVITE_ENDPOINTS) {
    assert.ok(
      MOUNTED_ENDPOINTS.includes(path),
      `${path} is not in the measured surface — re-measure before trusting this list`,
    );
    assert.ok(!ALLOWED.includes(path), `${path} became an allowed door — D143 opens ZERO`);

    // The bodies each endpoint would actually need. `invitationId` is a real id
    // SHAPE (32 alphanumerics, the measured 1.7.1 generator), so a guard removed
    // from `route.ts` would let these reach a schema that accepts them rather
    // than one that rejects them for being empty.
    const body = JSON.stringify({
      email: "invitee@obstack.invalid",
      role: "member",
      organizationId: "org_someone_else",
      invitationId: "a".repeat(32),
    });
    await refusal(
      await POST(
        new Request(at(path), {
          method: "POST",
          headers: { ...SESSION, "content-type": "application/json" },
          body,
        }),
      ),
    );
    await refusal(await GET(new Request(`${at(path)}?id=${"a".repeat(32)}`, { headers: SESSION })));
  }
});

/**
 * The falsification probe (S2.2 L1): without it the matrix above would stay
 * green if the guard refused EVERYTHING, allowlist included. The two open doors
 * must reach better-auth — and reaching it, in a process with no secret, is a
 * throw. That throw is the evidence, and it is also why a 404 from the fifty
 * others means no better-auth code ran for them.
 */
test("D120 falsification: the two allowed endpoints do reach better-auth", async () => {
  await assert.rejects(
    POST(new Request(at("/sign-out"), { method: "POST", headers: SESSION })),
    /BETTER_AUTH_SECRET/,
  );
  await assert.rejects(GET(new Request(at("/get-session"), { headers: SESSION })), /BETTER_AUTH_SECRET/);
});

test("D120: the allowlist is total over the ways a path can be spelled", async () => {
  const variants = [
    "/sign-up/email",
    "/sign-up/email/",
    "/sign-up/email?callbackURL=/app",
    "/SIGN-UP/EMAIL",
    "/sign-up%2Femail",
    "/sign-up/./email",
    "/get-session/../sign-up/email",
    "/organization/create/../../sign-up/email",
    "//sign-up/email",
    "/sign-up/email%00",
    "/sign-up/email%zz",
  ];
  for (const path of variants) {
    const response = await POST(new Request(at(path), { method: "POST", headers: SESSION }));
    assert.equal(response.status, 404, `${path} was not refused`);
  }

  // ...and a trailing slash does not lock a stranger out of the doors that ARE open
  await assert.rejects(POST(new Request(at("/sign-out/"), { method: "POST" })), /BETTER_AUTH_SECRET/);
});

// ---- D121: `?error=` is a closed vocabulary, not a message channel ----

test("D121: every code maps to its own fixed copy", () => {
  // The vocabulary is closed and D129 fixes its contents: exactly these codes,
  // each one a failure a stranger can actually do something about. A new entry
  // is a ruling, not a refactor, so it turns this red on the way in.
  assert.deepEqual(Object.keys(SIGNUP_ERRORS), [
    "missing-fields",
    "exists",
    "invalid-email",
    "password-short",
    "password-long",
    "rate_limited",
    "signup-failed",
  ]);
  assert.deepEqual(Object.keys(LOGIN_ERRORS), [
    "missing-fields",
    "invalid-email",
    "invalid-credentials",
    "rate_limited",
    "login-failed",
  ]);
  // D149's enum, and it is short for a measured reason asserted below: 1.7.1
  // collapses expired / accepted / cancelled / never-existed into one answer.
  assert.deepEqual(Object.keys(INVITE_ERRORS), ["not-found", "not-recipient", "invite-failed"]);

  // D129's two additions say what to change, and say a true number: 8 and 128
  // are better-auth 1.7.1's documented defaults and `authConfig()` overrides
  // neither, so copy and server agree.
  assert.match(SIGNUP_ERRORS["password-short"], /at least 8 characters/);
  assert.match(SIGNUP_ERRORS["password-long"], /at most 128 characters/);
  for (const copy of [SIGNUP_ERRORS["invalid-email"], LOGIN_ERRORS["invalid-email"]]) {
    assert.match(copy, /you@example\.com/, "an invalid address needs an example of a valid one");
  }
  for (const [code, copy] of Object.entries(SIGNUP_ERRORS)) {
    assert.equal(signupErrorMessage(code), copy);
  }
  for (const [code, copy] of Object.entries(LOGIN_ERRORS)) {
    assert.equal(loginErrorMessage(code), copy);
  }
  for (const [code, copy] of Object.entries(INVITE_ERRORS)) {
    assert.equal(inviteErrorMessage(code), copy);
  }

  // D140/D13 on the one surface most tempted to promise something: the invite
  // copy may not say a switcher is coming, because none is (S3.5 owns it).
  for (const copy of Object.values(INVITE_ERRORS)) {
    assert.doesNotMatch(copy, /soon|will be able|coming/i, `invite copy promises a feature: ${copy}`);
  }
  // ...and the one thing a recipient CAN act on is named: the wrong-address case
  // says which account to sign in with rather than "try again".
  assert.match(INVITE_ERRORS["not-recipient"], /email address/i);
});

test("D121: absent means no message; the surfaces cannot render each other's copy", () => {
  assert.equal(signupErrorMessage(undefined), null);
  assert.equal(loginErrorMessage(undefined), null);
  assert.equal(inviteErrorMessage(undefined), null);
  // a login code on the signup page is just an unknown code, and vice versa
  assert.equal(signupErrorMessage("invalid-credentials"), SIGNUP_ERRORS["signup-failed"]);
  assert.equal(loginErrorMessage("exists"), LOGIN_ERRORS["login-failed"]);
  assert.equal(inviteErrorMessage("exists"), INVITE_ERRORS["invite-failed"]);
  assert.equal(signupErrorMessage("not-recipient"), SIGNUP_ERRORS["signup-failed"]);
});

test("D68 totality: no hostile ?error= value throws, escapes the vocabulary, or reaches the page", () => {
  assert.equal(HOSTILE_URL_VALUES.length, 15, "the D68 corpus changed size; the ruling fixes its contents");
  for (const required of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__", ""]) {
    assert.ok(HOSTILE_URL_VALUES.includes(required), `the corpus lost ${JSON.stringify(required)}`);
  }

  // The invite surface joins BY RULE, not by growing a corpus of its own
  // (`lib/hostile-url-values.ts`): a new `?error=` vocabulary is a new row here.
  const surfaces = [
    { name: "signup", resolve: signupErrorMessage, copy: Object.values(SIGNUP_ERRORS) as string[] },
    { name: "login", resolve: loginErrorMessage, copy: Object.values(LOGIN_ERRORS) as string[] },
    { name: "invite", resolve: inviteErrorMessage, copy: Object.values(INVITE_ERRORS) as string[] },
  ];

  for (const value of HOSTILE_URL_VALUES) {
    for (const { name, resolve, copy } of surfaces) {
      const where = `${name}?error=${Array.isArray(value) ? value.join(",") : value.slice(0, 20)}`;

      // (a) never throws — `?error=toString` walked the prototype chain in the
      // measured D68 failure and would come back a function here
      const message = ((): string | null => {
        try {
          return resolve(value);
        } catch (error) {
          assert.fail(`${where} threw ${String(error)} — a URL parse must never throw (D68)`);
        }
      })();

      // (b) in-domain: a present value always resolves to one of this surface's
      // own sentences, never null and never anything else
      assert.ok(typeof message === "string", `${where} produced ${String(message)} instead of copy`);
      assert.ok(copy.includes(message), `${where} escaped the vocabulary: ${JSON.stringify(message)}`);

      // (c) never reflected: nothing a link author wrote appears on the page
      const needle = Array.isArray(value) ? value[0] : value;
      if (needle.length > 0) {
        assert.ok(!message.includes(needle), `${where} reflected its own value into the page`);
      }
    }
  }
});

// ---- D133: the library-code → vocabulary mapping, arm by arm ----
//
// This mapping used to live inside the two `"use server"` action modules, which
// may export nothing but async functions — so it could not be reached from a
// test at all, and its arms were covered only insofar as a live signup happened
// to raise them. It now sits in `errors.ts` beside the words it selects, and
// every arm is asserted here directly: the shadowed `INVALID_EMAIL` arm on the
// signup side is proven without depending on being reachable at 1.7.1.
//
// The errors are REAL `APIError` instances, not hand-shaped objects. The mapping
// keys off `error.name === "APIError"`, and only the real class can prove that
// assumption still holds after an upgrade.

const apiError = (code: string, message = "") =>
  new APIError("BAD_REQUEST", { code, message });

/** Every code arm on the signup surface, with the vocabulary member it selects. */
const SIGNUP_ARMS: ReadonlyArray<[string, SignupErrorCode]> = [
  ["USER_ALREADY_EXISTS", "exists"],
  ["USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", "exists"],
  ["INVALID_EMAIL", "invalid-email"],
  ["PASSWORD_TOO_SHORT", "password-short"],
  ["PASSWORD_TOO_LONG", "password-long"],
];

/** Every code arm on the login surface. */
const LOGIN_ARMS: ReadonlyArray<[string, LoginErrorCode]> = [
  ["INVALID_EMAIL_OR_PASSWORD", "invalid-credentials"],
  ["INVALID_EMAIL", "invalid-email"],
];

/**
 * Real better-auth 1.7.1 base codes that neither surface maps, plus each
 * surface's own mapped codes, which the OTHER surface must still treat as
 * unknown — `PASSWORD_TOO_LONG` is a signup answer and must not become login
 * copy just because both vocabularies contain the word password.
 */
const UNMAPPED_LIBRARY_CODES = [
  "USER_NOT_FOUND",
  "FAILED_TO_CREATE_USER",
  "FAILED_TO_CREATE_SESSION",
  "FAILED_TO_UPDATE_USER",
  "FAILED_TO_GET_SESSION",
  "INVALID_PASSWORD",
  "INVALID_USER",
  "INVALID_TOKEN",
  "TOKEN_EXPIRED",
  "EMAIL_NOT_VERIFIED",
  "SESSION_EXPIRED",
  "SESSION_NOT_FRESH",
  "ACCOUNT_NOT_FOUND",
  "CREDENTIAL_ACCOUNT_NOT_FOUND",
  "INVALID_ORIGIN",
  "EMAIL_CAN_NOT_BE_UPDATED",
  "CHANGE_EMAIL_DISABLED",
];

test("D133: every signup arm maps directly, from a real APIError", () => {
  assert.equal(SIGNUP_ARMS.length, 5, "an arm was added or removed without a direct assertion");
  for (const [code, expected] of SIGNUP_ARMS) {
    assert.equal(signupErrorCode(apiError(code)), expected, `signup arm ${code}`);
  }

  // The message-predicate arm: `VALIDATION_ERROR` is generic on its own and only
  // names the email field through the message prefix (the body carries no field
  // path), so the prefix is the arm.
  assert.equal(
    signupErrorCode(apiError("VALIDATION_ERROR", "[body.email] Invalid email address")),
    "invalid-email",
  );
  assert.equal(
    signupErrorCode(apiError("VALIDATION_ERROR", "[body.password] Too weak")),
    "signup-failed",
    "a validation error this code cannot attribute must not claim the address was wrong",
  );
  assert.equal(signupErrorCode(apiError("VALIDATION_ERROR")), "signup-failed");
});

test("D133: every login arm maps directly, from a real APIError", () => {
  assert.equal(LOGIN_ARMS.length, 2, "an arm was added or removed without a direct assertion");
  for (const [code, expected] of LOGIN_ARMS) {
    assert.equal(loginErrorCode(apiError(code)), expected, `login arm ${code}`);
  }
});

// ---- D339/F1: the rate-limit refusal gets its own vocabulary member ----
//
// Unlike every arm above, this one is not a real `APIError` at all — it is
// obstack's own limiter (`server/rate-limit.ts`) refusing BEFORE
// `signUpEmail` is ever called. `signupErrorCode` recognises it by
// `instanceof`, ahead of the `APIError` check, so it must win even against a
// forged object that merely LOOKS like an APIError.

test("D339: signupErrorCode maps RateLimitedError to its own member, never the generic one", () => {
  assert.equal(signupErrorCode(new RateLimitedError("signup")), "rate_limited");
  assert.notEqual(signupErrorCode(new RateLimitedError("signup")), "signup-failed");

  // instanceof, not duck-typing: an object merely shaped like the class (or
  // like an APIError) must not accidentally claim this arm or lose it.
  assert.equal(
    signupErrorCode({ name: "RateLimitedError", message: "too many signup attempts from this address" }),
    "signup-failed",
    "a forged RateLimitedError-shaped object must not claim the rate_limited arm",
  );
});

test("D133 totality: any code outside the arms lands on the generic member", () => {
  const armed = {
    signup: new Set(SIGNUP_ARMS.map(([code]) => code)),
    login: new Set(LOGIN_ARMS.map(([code]) => code)),
  };
  // each surface must also treat the other's answers as unknown
  const corpus = [
    ...UNMAPPED_LIBRARY_CODES,
    ...SIGNUP_ARMS.map(([code]) => code),
    ...LOGIN_ARMS.map(([code]) => code),
    ...HOSTILE_URL_VALUES.filter((v): v is string => typeof v === "string"),
  ];
  // S2.0 L1, same rule as the 52 above: a loop over a shrunken corpus is green
  // by vacuity, and a floor would let nine library codes leave unnoticed. Pinned,
  // because `UNMAPPED_LIBRARY_CODES` is the one input here whose size nothing
  // else asserts: 17 library codes + 5 signup arms + 2 login arms + 14 hostile
  // strings (the fifteenth D68 entry is the repeated-parameter ARRAY, which a
  // `body.code` never is, so `filter` drops it).
  assert.equal(
    corpus.length,
    38,
    "the totality corpus changed size — a library code or a hostile value moved, so re-check both lists before moving this number",
  );

  for (const code of corpus) {
    if (!armed.signup.has(code) && code !== "VALIDATION_ERROR") {
      assert.equal(signupErrorCode(apiError(code)), "signup-failed", `signup: ${code}`);
    }
    if (!armed.login.has(code)) {
      assert.equal(loginErrorCode(apiError(code)), "login-failed", `login: ${code}`);
    }
  }

  // ...and anything that is not an APIError at all — our own transaction
  // failing, a dead pool, a thrown string — is the generic too.
  for (const notApi of [
    new Error("connection terminated unexpectedly"),
    new SignupError("signup failed: the org and workspace could not be created"),
    { name: "APIError" },
    { body: { code: "PASSWORD_TOO_SHORT" } },
    "PASSWORD_TOO_SHORT",
    null,
    undefined,
  ]) {
    assert.equal(signupErrorCode(notApi), "signup-failed");
    assert.equal(loginErrorCode(notApi), "login-failed");
  }
});

// ---- D143/D149: the invite surface — id parse, error arms, link shape ----
//
// The library-code arms are pinned as STRINGS here because better-auth does not
// export `ORGANIZATION_ERROR_CODES` (measured: `better-auth/plugins/organization`
// exports exactly getOrgAdapter, hasPermission, organization, parseRoles). What
// closes that gap is `invites.integration.test.ts`, which drives the real
// endpoints into their real failures and asserts this mapping on the errors they
// actually throw — the same two-independent-measurements shape the 52-endpoint
// surface already has.

/** Every code arm on the invite surface, with the vocabulary member it selects. */
const INVITE_ARMS: ReadonlyArray<[string, InviteErrorCode]> = [
  ["INVITATION_NOT_FOUND", "not-found"],
  ["YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION", "not-recipient"],
];

test("D149: every invite arm maps directly, from a real APIError", () => {
  assert.equal(INVITE_ARMS.length, 2, "an arm was added or removed without a direct assertion");
  for (const [code, expected] of INVITE_ARMS) {
    assert.equal(inviteErrorCode(apiError(code)), expected, `invite arm ${code}`);
  }

  // The message arm: `getInvitation` raises the not-found situation through
  // `APIError.fromStatus`, which carries NO code (measured, crud-invites.mjs:503)
  // — so the message is the only thing identifying it, exactly as the signup
  // surface's `[body.email]` prefix is.
  assert.equal(
    inviteErrorCode(new APIError("BAD_REQUEST", { message: "Invitation not found!" })),
    "not-found",
  );
  // ...and the codeless UNAUTHORIZED from the same endpoint is NOT that arm: the
  // page answers "no session" before it ever calls, so a generic here is right.
  assert.equal(
    inviteErrorCode(new APIError("UNAUTHORIZED", { message: "Not authenticated" })),
    "invite-failed",
  );
});

test("D149 totality: any code outside the arms lands on the generic member", () => {
  const armed = new Set(INVITE_ARMS.map(([code]) => code));
  const corpus = [
    ...UNMAPPED_LIBRARY_CODES,
    ...INVITE_ARMS.map(([code]) => code),
    // real organization-plugin codes the accept path can raise and this surface
    // deliberately does not name — nothing a recipient can act on
    "ORGANIZATION_NOT_FOUND",
    "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED",
    "INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION",
    // the guard D143 lists as an ESCALATION rather than a code: it cannot fire in
    // this config, and if it ever does it must reach an operator through the
    // action's log, not become quiet copy
    "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION",
    "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION",
    ...HOSTILE_URL_VALUES.filter((v): v is string => typeof v === "string"),
  ];
  assert.equal(corpus.length, 38, "the invite totality corpus changed size — re-check both lists");

  for (const code of corpus) {
    if (!armed.has(code)) assert.equal(inviteErrorCode(apiError(code)), "invite-failed", code);
  }
  for (const notApi of [
    new Error("connection terminated unexpectedly"),
    { name: "APIError" },
    { body: { code: "INVITATION_NOT_FOUND" } },
    "INVITATION_NOT_FOUND",
    null,
    undefined,
  ]) {
    assert.equal(inviteErrorCode(notApi), "invite-failed");
  }
});

test("D68 totality: the invitation-id parse is total, and its answer is always an id or nothing", () => {
  // A real 1.7.1 id shape: 32 characters from [a-zA-Z0-9]
  // (@better-auth/core/dist/utils/id.mjs). The integration test asserts a REAL
  // invitation's id against the same regex, so this fixture cannot drift from
  // the library alone.
  const REAL = "aB3xQ7zLmN0pR5tV9wY2cD4fG6hJ8kS1";
  assert.equal(parseInvitationId(REAL), REAL);
  assert.equal(inviteLinkPath(REAL), `/invite/${REAL}`);

  for (const value of HOSTILE_URL_VALUES) {
    const parsed = ((): string | null => {
      try {
        return parseInvitationId(value);
      } catch (error) {
        assert.fail(`parseInvitationId threw ${String(error)} — a URL parse must never throw (D68)`);
      }
    })();
    // in-domain: null, or something that IS an id — never the caller's string
    // carried forward, which is what keeps a 5000-char value or a `%00` out of
    // both Postgres and any URL this app writes
    if (parsed !== null) {
      assert.match(parsed, /^[A-Za-z0-9]{1,64}$/, `escaped the id domain: ${JSON.stringify(parsed)}`);
    }
  }

  // named refusals, so the loop above cannot go green by a parse that answers
  // null to everything: these are the shapes that must NOT come back
  for (const refused of ["", "__proto__", "x".repeat(65), "%00", "a/b", "a b", "a-b", "a.b"]) {
    assert.equal(parseInvitationId(refused), null, `accepted ${JSON.stringify(refused)}`);
  }
  assert.equal(parseInvitationId(undefined), null);
  // a repeated parameter hands over an array; the first member is judged, and a
  // prototype name that IS alphanumeric is a valid id shape — safe, because an
  // id is only ever bound as `$1` and never used for a property lookup
  assert.equal(parseInvitationId([REAL, "second"]), REAL);
  assert.equal(parseInvitationId("toString"), "toString");
  assert.equal(parseInvitationId(["", "x"]), null);
});
