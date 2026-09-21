import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { QueryResultRow } from "pg";
import { APIError } from "better-auth";
import {
  ACCOUNT_ERRORS,
  ACCOUNT_NOTICES,
  accountErrorCode,
  accountErrorMessage,
  accountFeedback,
  accountNotice,
  sectionOf,
  type AccountErrorCode,
  type AccountNoticeCode,
} from "@/app/app/account/errors";
import { SIGNUP_ERRORS } from "@/app/signup/errors";
import { NAME_MAX, PASSWORD_MAX, PASSWORD_MIN, describeUserAgent } from "@/lib/account-types";
import { HOSTILE_URL_VALUES } from "@/lib/hostile-url-values";
import {
  EmailTaken,
  UnknownSession,
  listMemberships,
  listOwnSessions,
  parseDisplayName,
  parseSessionId,
  revokeOtherOwnSessions,
  revokeOwnSession,
} from "./account";
import type { QueryRows } from "./postgres";

// run with: npm test --workspace apps/web
//
// The account SURFACE this repo owns, with no server anywhere (D707): the two
// URL vocabularies and where each code lands (D712), the library-code arms
// (D133's shape), the two total parses (D68), the session statements' shape
// (D711 — never the token, always the owner pin, never the current row), and
// the user-agent label. The real-Postgres half is `account.integration.test.ts`.
//
// These two variables are deleted rather than merely left unset, for the same
// reason `auth.test.ts` deletes them: nothing here may reach better-auth or a
// pool, and a throw naming either variable is how it would show.
delete process.env.BETTER_AUTH_SECRET;
delete process.env.OBSTACK_POSTGRES_DSN;

const HERE = path.dirname(fileURLToPath(import.meta.url));

type Statement = { sql: string; params?: unknown[] };

function recordingQuery(rows: unknown[]) {
  const seen: Statement[] = [];
  const query: QueryRows = async <Row extends QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> => {
    seen.push({ sql, params });
    return rows as Row[];
  };
  return { query, seen };
}

// ---- D712: two closed vocabularies, one page, one section per code ----

test("D712: the two vocabularies are closed, and every code maps to its own fixed copy", () => {
  // A new entry is a ruling, not a refactor, so it turns this red on the way in.
  assert.deepEqual(Object.keys(ACCOUNT_ERRORS), [
    "name-invalid",
    "email-missing",
    "email-invalid",
    "email-same",
    "email-taken",
    "email-rate-limited",
    "password-missing",
    "password-mismatch",
    "password-unchanged",
    "password-incorrect",
    "password-short",
    "password-long",
    "password-rate-limited",
    "session-not-found",
    "account-failed",
  ]);
  assert.deepEqual(Object.keys(ACCOUNT_NOTICES), [
    "name",
    "email",
    "password",
    "password-sessions",
    "session",
    "sessions",
  ]);
  for (const [code, copy] of Object.entries(ACCOUNT_ERRORS)) {
    assert.equal(accountErrorMessage(code), copy);
  }
  for (const [code, copy] of Object.entries(ACCOUNT_NOTICES)) {
    assert.equal(accountNotice(code), copy);
  }
});

test("D712: absent means nothing; unknown is the generic sentence for an error and NOTHING for a notice", () => {
  assert.equal(accountErrorMessage(undefined), null);
  assert.equal(accountNotice(undefined), null);
  // The surfaces cannot render each other's copy: a signup code here is an
  // unknown code, a notice code is not an error, an error code is not a notice.
  assert.equal(accountErrorMessage("exists"), ACCOUNT_ERRORS["account-failed"]);
  assert.equal(accountErrorMessage("password"), ACCOUNT_ERRORS["account-failed"]);
  assert.equal(accountNotice("password-short"), null);
  assert.equal(accountNotice("exists"), null);
  assert.equal(accountFeedback({}), null);
});

test("D712: a code lands in the section its first word names, and the generic member at the page level", () => {
  const expectedErrorSections: Record<AccountErrorCode, ReturnType<typeof sectionOf>> = {
    "name-invalid": "name",
    "email-missing": "email",
    "email-invalid": "email",
    "email-same": "email",
    "email-taken": "email",
    "email-rate-limited": "email",
    "password-missing": "password",
    "password-mismatch": "password",
    "password-unchanged": "password",
    "password-incorrect": "password",
    "password-short": "password",
    "password-long": "password",
    "password-rate-limited": "password",
    "session-not-found": "sessions",
    "account-failed": "account",
  };
  const expectedNoticeSections: Record<AccountNoticeCode, ReturnType<typeof sectionOf>> = {
    name: "name",
    email: "email",
    password: "password",
    "password-sessions": "password",
    session: "sessions",
    sessions: "sessions",
  };
  for (const [code, section] of Object.entries(expectedErrorSections)) {
    assert.equal(sectionOf(code), section, code);
    assert.deepEqual(accountFeedback({ error: code }), {
      kind: "error",
      section,
      message: ACCOUNT_ERRORS[code as AccountErrorCode],
    });
  }
  for (const [code, section] of Object.entries(expectedNoticeSections)) {
    assert.equal(sectionOf(code), section, code);
    assert.deepEqual(accountFeedback({ saved: code }), {
      kind: "notice",
      section,
      message: ACCOUNT_NOTICES[code as AccountNoticeCode],
    });
  }
  // An error outranks a notice: no action here writes both, so a URL carrying
  // both was written by hand, and the refusal is the safer thing to show.
  assert.equal(accountFeedback({ error: "password-short", saved: "password" })?.kind, "error");
  // The section comes from the RESOLVED code: an unknown error code is the
  // generic sentence at the page level, never a section a link author picked.
  assert.deepEqual(accountFeedback({ error: "password-nonsense" }), {
    kind: "error",
    section: "account",
    message: ACCOUNT_ERRORS["account-failed"],
  });
});

test("D129: every sentence is present tense and names what the reader can do", () => {
  for (const copy of [...Object.values(ACCOUNT_ERRORS), ...Object.values(ACCOUNT_NOTICES)]) {
    assert.doesNotMatch(copy, /soon|will be able|coming/i, `account copy promises a feature: ${copy}`);
  }
  // The two length numbers are the library's documented defaults, stated
  // through the constants and ALSO stated by hand in the signup vocabulary —
  // three spellings of one fact, asserted to be one fact.
  assert.match(SIGNUP_ERRORS["password-short"], new RegExp(`at least ${PASSWORD_MIN} characters`));
  assert.match(SIGNUP_ERRORS["password-long"], new RegExp(`at most ${PASSWORD_MAX} characters`));
  assert.match(ACCOUNT_ERRORS["password-short"], new RegExp(`at least ${PASSWORD_MIN} characters`));
  assert.match(ACCOUNT_ERRORS["password-long"], new RegExp(`at most ${PASSWORD_MAX} characters`));
  assert.match(ACCOUNT_ERRORS["name-invalid"], new RegExp(`1 to ${NAME_MAX} characters`));
  assert.match(ACCOUNT_ERRORS["email-invalid"], /you@example\.com/, "an invalid address needs an example of a valid one");
  // The page's own copy states the same two numbers through the same constants
  // — read as text, because the component imports `next/link` (D54(ii)).
  const live = readFileSync(path.join(HERE, "../components/account/AccountLive.tsx"), "utf8");
  assert.ok(live.includes("{PASSWORD_MIN} to {PASSWORD_MAX} characters"), "the password hint stopped rendering the constants");
  assert.ok(live.includes("minLength={PASSWORD_MIN}") && live.includes("maxLength={PASSWORD_MAX}"));
});

test("D68 totality: no hostile ?error= or ?saved= value throws, escapes the vocabularies, or reaches the page", () => {
  assert.equal(HOSTILE_URL_VALUES.length, 15, "the D68 corpus changed size; the ruling fixes its contents");
  const errorCopy = Object.values(ACCOUNT_ERRORS) as string[];
  const noticeCopy = Object.values(ACCOUNT_NOTICES) as string[];
  for (const value of HOSTILE_URL_VALUES) {
    const needle = Array.isArray(value) ? value[0] : value;
    const where = `?=${needle.slice(0, 20)}`;

    const message = accountErrorMessage(value);
    assert.ok(typeof message === "string" && errorCopy.includes(message), `error${where} escaped the vocabulary`);
    if (needle.length > 0) assert.ok(!message.includes(needle), `error${where} reflected its value`);

    const notice = accountNotice(value);
    assert.ok(notice === null || noticeCopy.includes(notice), `saved${where} escaped the vocabulary`);

    const asError = accountFeedback({ error: value });
    assert.equal(asError?.kind, "error");
    assert.equal(asError?.section, "account", `error${where} landed in a section a link author chose`);
    const asNotice = accountFeedback({ saved: value });
    assert.ok(asNotice === null || noticeCopy.includes(asNotice.message), `saved${where} produced a claim`);
  }
});

// ---- D133: the library-code → vocabulary mapping, arm by arm ----

const apiError = (code: string, message = "") => new APIError("BAD_REQUEST", { code, message });

test("D133: every arm maps directly, from a real APIError or one of our own two classes", () => {
  assert.equal(accountErrorCode(apiError("INVALID_PASSWORD")), "password-incorrect");
  assert.equal(accountErrorCode(apiError("PASSWORD_TOO_SHORT")), "password-short");
  assert.equal(accountErrorCode(apiError("PASSWORD_TOO_LONG")), "password-long");
  assert.equal(accountErrorCode(apiError("INVALID_EMAIL")), "email-invalid");
  // MEASURED at 1.7.1 with this config: `/change-email`'s body schema refuses
  // a malformed address before any session read, and the field is named only
  // in the message — the shape `account.integration.test.ts` re-measures
  // against the real call.
  assert.equal(
    accountErrorCode(apiError("VALIDATION_ERROR", "[body.newEmail] Invalid email address")),
    "email-invalid",
  );
  assert.equal(
    accountErrorCode(apiError("VALIDATION_ERROR", "[body.name] Expected string")),
    "account-failed",
    "a validation error this code cannot attribute must not claim the address was wrong",
  );
  // Codeless, like the invite surface's not-found: the message is the arm.
  assert.equal(
    accountErrorCode(new APIError("BAD_REQUEST", { message: "Email is the same" })),
    "email-same",
  );
  assert.equal(accountErrorCode(new EmailTaken("x@obstack.invalid")), "email-taken");
  assert.equal(accountErrorCode(new UnknownSession("sess")), "session-not-found");
});

test("D133 totality: any code outside the arms lands on the generic member", () => {
  const unmapped = [
    // real base codes the three account endpoints can raise and this surface
    // deliberately does not name — nothing a signed-in person can act on
    "CREDENTIAL_ACCOUNT_NOT_FOUND",
    "SESSION_EXPIRED",
    "SESSION_NOT_FRESH",
    "EMAIL_CAN_NOT_BE_UPDATED",
    "CHANGE_EMAIL_DISABLED",
    "UNAUTHORIZED",
    "FAILED_TO_UPDATE_USER",
    "FAILED_TO_GET_SESSION",
    // the other surfaces' answers, which must stay unknown here
    "INVALID_EMAIL_OR_PASSWORD",
    "USER_ALREADY_EXISTS",
    "INVITATION_NOT_FOUND",
    ...HOSTILE_URL_VALUES.filter((v): v is string => typeof v === "string"),
  ];
  assert.equal(unmapped.length, 25, "the totality corpus changed size — re-check the list before moving this number");
  for (const code of unmapped) {
    assert.equal(accountErrorCode(apiError(code)), "account-failed", code);
  }
  for (const notApi of [
    new Error("connection terminated unexpectedly"),
    { name: "APIError" },
    { body: { code: "INVALID_PASSWORD" } },
    "INVALID_PASSWORD",
    null,
    undefined,
  ]) {
    assert.equal(accountErrorCode(notApi), "account-failed");
  }
});

// ---- D68: the two total parses ----

test("D68: parseDisplayName is total — a trimmed one-line name of 1 to NAME_MAX characters, or null", () => {
  assert.equal(parseDisplayName("  Ada Lovelace "), "Ada Lovelace");
  assert.equal(parseDisplayName("x".repeat(NAME_MAX)), "x".repeat(NAME_MAX));
  for (const refused of ["", "   ", "x".repeat(NAME_MAX + 1), "a\nb", "a\tb", "\u0000", "a\u007fb"]) {
    assert.equal(parseDisplayName(refused), null, `accepted ${JSON.stringify(refused)}`);
  }
  assert.equal(parseDisplayName(null), null);
  assert.equal(parseDisplayName(undefined), null);
  for (const value of HOSTILE_URL_VALUES) {
    const parsed = ((): string | null => {
      try {
        return parseDisplayName(value as unknown as string);
      } catch (error) {
        assert.fail(`parseDisplayName threw ${String(error)} — a parse must never throw (D68)`);
      }
    })();
    if (parsed !== null) {
      assert.ok(parsed.length >= 1 && parsed.length <= NAME_MAX && parsed === parsed.trim());
    }
  }
  // a repeated field is not a string and gets nothing, not its first member
  assert.equal(parseDisplayName(["first", "second"] as unknown as string), null);
  // a 5000-character value is the one D68 shape the bound exists for
  assert.equal(parseDisplayName("x".repeat(5000)), null);
});

test("D68: parseSessionId is total, and its answer is always an id or nothing", () => {
  // A real 1.7.1 id shape: 32 characters from [a-zA-Z0-9] — the integration
  // test asserts a REAL session row's id against the same regex.
  const REAL = "aB3xQ7zLmN0pR5tV9wY2cD4fG6hJ8kS1";
  assert.equal(parseSessionId(REAL), REAL);
  for (const value of HOSTILE_URL_VALUES) {
    const parsed = parseSessionId(value as unknown as string);
    if (parsed !== null) assert.match(parsed, /^[A-Za-z0-9]{1,64}$/, `escaped the id domain: ${parsed}`);
  }
  for (const refused of ["", "__proto__", "x".repeat(65), "%00", "a/b", "a b", "a-b", "a.b", "sess_1"]) {
    assert.equal(parseSessionId(refused), null, `accepted ${JSON.stringify(refused)}`);
  }
  assert.equal(parseSessionId(undefined), null);
  assert.equal(parseSessionId(["first", "second"] as unknown as string), null);
  // alphanumeric prototype names are valid id SHAPES and safe: an id is only
  // ever bound as `$1` or compared, never used for a property lookup
  assert.equal(parseSessionId("toString"), "toString");
});

// ---- D711: the session statements, by shape ----

test("D711: the session list never selects the token, filters expired rows, and binds the user", async () => {
  const { query, seen } = recordingQuery([
    {
      id: "sessA",
      created_at: new Date("2026-09-20T10:00:00Z"),
      expires_at: new Date("2026-10-20T10:00:00Z"),
      ip_address: null,
      user_agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36",
    },
  ]);
  const sessions = await listOwnSessions("user-1", query);

  assert.equal(seen.length, 1);
  const { sql, params } = seen[0];
  assert.doesNotMatch(sql, /token/i, "the session list must never read the bearer secret");
  assert.match(sql, /FROM "session"/);
  assert.match(sql, /"userId" = \$1/);
  assert.match(sql, /"expiresAt" > now\(\)/);
  assert.deepEqual(params, ["user-1"]);

  assert.deepEqual(sessions, [
    {
      id: "sessA",
      createdAt: new Date("2026-09-20T10:00:00Z"),
      expiresAt: new Date("2026-10-20T10:00:00Z"),
      ipAddress: null,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36",
    },
  ]);
});

test("D711: a single revoke binds the id, the owner AND the current session, and refuses on zero rows", async () => {
  const { query, seen } = recordingQuery([{ id: "sessB" }]);
  await revokeOwnSession("user-1", "sessB", "sessA", query);
  assert.match(seen[0].sql, /DELETE FROM "session"/);
  assert.match(seen[0].sql, /id = \$1 AND "userId" = \$2 AND id <> \$3/);
  assert.match(seen[0].sql, /RETURNING id/);
  assert.deepEqual(seen[0].params, ["sessB", "user-1", "sessA"]);

  // no row matched — a foreign id, a spent id or the current one — is a named
  // refusal, never a silent success
  const refused = recordingQuery([]);
  await assert.rejects(revokeOwnSession("user-1", "sessZ", "sessA", refused.query), (error: unknown) => {
    assert.ok(error instanceof UnknownSession);
    assert.equal((error as Error).name, "UnknownSession");
    return true;
  });
});

test("D711: revoking the others binds the owner and excludes the current session, and answers how many ended", async () => {
  const { query, seen } = recordingQuery([{ id: "sessB" }, { id: "sessC" }]);
  assert.equal(await revokeOtherOwnSessions("user-1", "sessA", query), 2);
  assert.match(seen[0].sql, /DELETE FROM "session"/);
  assert.match(seen[0].sql, /"userId" = \$1 AND id <> \$2/);
  assert.deepEqual(seen[0].params, ["user-1", "sessA"]);
});

test("memberships join the member row to its organization and bind the user", async () => {
  const { query, seen } = recordingQuery([
    { org_id: "org_a", org_name: "Alice's org", role: "owner", joined_at: new Date("2026-09-01T00:00:00Z") },
    { org_id: "org_b", org_name: "Bob's org", role: "member", joined_at: new Date("2026-09-02T00:00:00Z") },
  ]);
  const memberships = await listMemberships("user-1", query);
  assert.match(seen[0].sql, /FROM "member" m/);
  assert.match(seen[0].sql, /JOIN "organization" o ON o\.id = m\."organizationId"/);
  assert.match(seen[0].sql, /WHERE m\."userId" = \$1/);
  assert.deepEqual(seen[0].params, ["user-1"]);
  assert.deepEqual(
    memberships.map((m) => [m.orgName, m.role]),
    [
      ["Alice's org", "owner"],
      ["Bob's org", "member"],
    ],
  );
});

// ---- the user-agent label ----

test("describeUserAgent reads the family names an agent spells, in nesting order, and guesses nothing", () => {
  const cases: [string | null, string][] = [
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      "Chrome on macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
      "Edge on Windows",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Firefox on Linux"],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
      "Safari on iOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      "Safari on macOS",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
      "Chrome on Android",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.0.0 Mobile/15E148 Safari/604.1",
      "Chrome on iOS",
    ],
    // the e2e drive's own browser — one word, no boundary before the family
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36",
      "Chrome on Linux",
    ],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36", "Chrome on ChromeOS"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "browser on Linux"],
    ["curl/8.6.0", "unknown browser"],
    ["node", "unknown browser"],
    ["", "unknown browser"],
    [null, "unknown browser"],
  ];
  for (const [ua, label] of cases) {
    assert.equal(describeUserAgent(ua), label, String(ua));
  }
});
