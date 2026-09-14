import assert from "node:assert/strict";
import test from "node:test";
import { APIError } from "better-auth";
import type { QueryResultRow } from "pg";
import {
  SETTINGS_ERRORS,
  settingsErrorCode,
  settingsErrorMessage,
  type SettingsErrorCode,
} from "@/app/app/settings/errors";
import { HOSTILE_URL_VALUES } from "@/lib/hostile-url-values";
import {
  KEY_NAME_MAX,
  KEY_PREFIX_LENGTH,
  KEY_TOKEN_PREFIX,
  UnknownApiKey,
  generateToken,
  hashToken,
  issueApiKey,
  keyPrefix,
  listApiKeys,
  parseKeyName,
  parseKeyScope,
  resolveApiKey,
  revokeApiKey,
} from "./api-keys";
import { API_KEY_SCOPES, DEFAULT_API_KEY_SCOPE, MCP_ADMITTED_SCOPES } from "@/lib/mcp-types";
import { OverrideLimit, UnknownOverride } from "./ingest-health";
import type { QueryRows } from "./postgres";

// run with: npm test --workspace apps/web
//
// The web half of the key contract, with no Postgres at all: the D139 token and
// hash rules, the workspace binding on every statement the store issues, and the
// settings surface's error vocabulary (D121/D129/D133). The rows-actually-agree
// half — that ingest's lookup finds what this issues, and that the stored row
// cannot reproduce the token — is `api-keys.integration.test.ts`.
//
// This file also owns the settings vocabulary's unit coverage: it is the only
// unit test file this task brings, and the mapping lives in `settings/errors.ts`
// precisely so a test can reach it at all (D133).

type Statement = { sql: string; params?: unknown[] };

function recordingQuery(rows: unknown[] = []) {
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

/** A row shaped like the one Postgres RETURNs, for the calls that read one back. */
const rowFor = (id = "key_0011223344556677") => ({
  id,
  name: "collector",
  prefix: "ok_live_9f3a",
  scope: "ingest" as const,
  created_at: new Date("2026-08-19T10:00:00Z"),
  revoked_at: null,
});

// ---- D139: the token and hash contract, the seam two languages implement ----

test("D139: the pinned cross-language vector — SHA-256('ok_dev_local'), lowercase hex", () => {
  // The SAME assertion stands in the Go suite (T1) and the SAME value is the
  // `token_hash` of the continuity row `0004_api_keys.sql` seeds. It is not
  // computed here from anything this module owns: it is a constant, measured
  // outside both processes (`printf 'ok_dev_local' | shasum -a 256`), so the two
  // implementations are pinned to a third party rather than to each other.
  assert.equal(
    hashToken("ok_dev_local"),
    "45880674fdc48bbcd49721bf6ac190e804836ca4fcd54c736c604153f4947e20",
  );

  // The encoding half of the same contract, which an ASCII vector cannot prove:
  // UTF-8 bytes. `printf 'ok_live_\xc3\xa9' | shasum -a 256` is this value, and a
  // hash taken over UTF-16 or latin1 bytes is a different one — which is exactly
  // how a key issued here would stop resolving in Go without any test going red.
  assert.equal(
    hashToken("ok_live_é"),
    "e9d4d753fa6e21f9da99b36f719d76ad9d01526bf9b47fcf2c5b1925a0b458db",
  );

  // lowercase hex, 64 characters, for any input
  for (const token of ["", "ok_dev_local", generateToken(), "x".repeat(5000)]) {
    assert.match(hashToken(token), /^[0-9a-f]{64}$/);
  }
});

test("D139: an issued token is `ok_live_` + 64 hex from 32 CSPRNG bytes", () => {
  const token = generateToken();
  assert.match(token, /^ok_live_[0-9a-f]{64}$/);
  assert.equal(token.length, 72, "8 characters of marker + 64 of hex = 256 bits of entropy");
  assert.equal(KEY_TOKEN_PREFIX, "ok_live_");

  // distinct, and not by a counter: 200 draws, no collision. A generator that
  // returned a constant — or seeded itself per process — passes every shape
  // assertion above and fails this one.
  const drawn = new Set(Array.from({ length: 200 }, generateToken));
  assert.equal(drawn.size, 200);
});

test("D139: the display prefix is token[0:12], for both shapes", () => {
  assert.equal(KEY_PREFIX_LENGTH, 12);
  const token = generateToken();
  assert.equal(keyPrefix(token), token.slice(0, 12));
  assert.match(keyPrefix(token), /^ok_live_[0-9a-f]{4}$/);
  // The dev credential's prefix IS the whole token, honestly — it is published
  // in a README, so there is nothing for a display prefix to hide (D139).
  assert.equal(keyPrefix("ok_dev_local"), "ok_dev_local");
  // 12 characters of an `ok_live_` token is 4 hex characters of entropy: enough
  // to recognise a key in a list, far too little to spend.
  assert.equal(keyPrefix(token).length - KEY_TOKEN_PREFIX.length, 4);
});

// ---- the store: one workspace, bound, on every statement ----

test("every statement is bound to the workspace it was handed", async () => {
  const { query, seen } = recordingQuery([rowFor()]);

  await listApiKeys("ws_a", query);
  await issueApiKey("ws_a", "collector", "ingest", query);
  await revokeApiKey("ws_a", "key_0011223344556677", query);
  // S8.1 (D642): the FOURTH statement is the MCP door, and it is the one
  // statement in this module whose workspace is the OUTPUT — the hash is the
  // owner pin, in the direction ingest already runs it. It joins this loop with
  // its own assertion rather than an exemption, so a fifth statement that binds
  // neither still has nowhere to hide.
  const token = generateToken();
  await resolveApiKey(token, query);

  assert.equal(seen.length, 4, "a statement was added without joining this loop");
  for (const { sql, params } of seen) {
    if (/token_hash = \$1/.test(sql)) {
      assert.match(sql, /scope = ANY\(\$2::text\[\]\)/, `the resolve does not bind the admitted scopes: ${sql}`);
      assert.match(sql, /revoked_at IS NULL/, `the resolve admits revoked keys: ${sql}`);
      assert.equal(params?.[0], hashToken(token), "the resolve bound something other than the token's hash");
      assert.deepEqual(params?.[1], [...MCP_ADMITTED_SCOPES], "the resolve's scope list is not MCP_ADMITTED_SCOPES");
      assert.equal(sql.includes(token), false, "the resolve carries the token itself in its text");
      continue;
    }
    // Both halves, because either alone is passable: SQL that names the column
    // but binds someone else's id, or a first binding no predicate reads.
    assert.match(sql, /workspace_id/, `a statement does not scope by workspace: ${sql}`);
    assert.equal(params?.[0], "ws_a", `a statement bound ${String(params?.[0])} as its workspace`);
  }
});

test("D642: the resolve answers null for no row, and the row's three fields for one", async () => {
  const empty = recordingQuery([]);
  assert.equal(await resolveApiKey(generateToken(), empty.query), null);
  const hit = recordingQuery([{ id: "key_0011223344556677", workspace_id: "ws_a", scope: "setup" }]);
  assert.deepEqual(await resolveApiKey(generateToken(), hit.query), {
    keyId: "key_0011223344556677",
    workspaceId: "ws_a",
    scope: "setup",
  });
});

test("D644: parseKeyScope is total — absent is ingest, a member is itself, everything else is null", () => {
  assert.equal(parseKeyScope(undefined), DEFAULT_API_KEY_SCOPE);
  assert.equal(parseKeyScope(null), DEFAULT_API_KEY_SCOPE);
  assert.equal(parseKeyScope(""), DEFAULT_API_KEY_SCOPE);
  for (const scope of API_KEY_SCOPES) assert.equal(parseKeyScope(scope), scope);
  assert.equal(parseKeyScope(["read", "setup"]), "read", "a repeated field takes its first value, like parseKeyName");
  for (const bad of ["admin", "READ", " read", "ingest;", 42, true, {}, [] as unknown[], ["admin"]]) {
    assert.equal(parseKeyScope(bad), null, `${JSON.stringify(bad)} parsed as a scope`);
  }
  for (const hostile of HOSTILE_URL_VALUES) {
    assert.doesNotThrow(() => parseKeyScope(hostile));
  }
});

test("shown once: the INSERT carries the hash and the prefix, and never the token", async () => {
  const { query, seen } = recordingQuery([rowFor()]);
  const { token, key } = await issueApiKey("ws_a", "collector", "ingest", query);

  const [workspaceId, name, prefix, tokenHash, id] = seen[0].params as string[];
  assert.equal(workspaceId, "ws_a");
  assert.equal(name, "collector");
  assert.equal(prefix, keyPrefix(token));
  assert.equal(tokenHash, hashToken(token));
  assert.match(id, /^key_[0-9a-f]{16}$/, "keys carry an app-generated id (D138)");

  // The property, stated over the whole statement rather than field by field:
  // nothing this call sends to Postgres contains the token or any part of it
  // beyond the twelve display characters.
  const sent = JSON.stringify(seen[0]);
  assert.equal(sent.includes(token), false, "the token itself reached the database");
  assert.equal(
    sent.includes(token.slice(KEY_PREFIX_LENGTH)),
    false,
    "the token's secret tail reached the database",
  );
  // ...and the row handed back describes the key without being able to name it
  assert.equal(JSON.stringify(key).includes(token), false);
});

test("the listed key is the row Postgres holds, revoked ones included", async () => {
  const revoked = { ...rowFor("key_ffffffffffffffff"), revoked_at: new Date("2026-08-19T12:00:00Z") };
  const { query, seen } = recordingQuery([rowFor(), revoked]);

  const keys = await listApiKeys("ws_a", query);
  assert.match(seen[0].sql, /WHERE workspace_id = \$1/);
  // Oldest first, id as the tie-break, so two keys issued in one second cannot
  // swap places between reads.
  assert.match(seen[0].sql, /ORDER BY created_at, id/);
  assert.equal(seen[0].sql.includes("token_hash"), false, "the list read the hash column");

  assert.deepEqual(keys, [
    {
      id: "key_0011223344556677",
      name: "collector",
      prefix: "ok_live_9f3a",
      scope: "ingest",
      createdAt: rowFor().created_at,
      revokedAt: null,
    },
    {
      id: "key_ffffffffffffffff",
      name: "collector",
      prefix: "ok_live_9f3a",
      scope: "ingest",
      createdAt: revoked.created_at,
      revokedAt: revoked.revoked_at,
    },
  ]);
});

test("revoke names the workspace and the key, and keeps the first revocation's time", async () => {
  const { query, seen } = recordingQuery([{ ...rowFor(), revoked_at: new Date("2026-08-19T12:00:00Z") }]);
  const key = await revokeApiKey("ws_a", "key_0011223344556677", query);

  assert.match(seen[0].sql, /UPDATE api_keys/);
  assert.match(seen[0].sql, /WHERE workspace_id = \$1 AND id = \$2/);
  assert.deepEqual(seen[0].params, ["ws_a", "key_0011223344556677"]);
  // `coalesce` rather than `revoked_at IS NULL` in the WHERE: re-revoking must
  // still RETURN the row, so that zero rows means one thing only — not this
  // workspace's key — instead of also meaning "already revoked".
  assert.match(seen[0].sql, /SET revoked_at = coalesce\(revoked_at, now\(\)\)/);
  assert.equal(/WHERE[^]*revoked_at IS NULL/.test(seen[0].sql), false, seen[0].sql);
  assert.match(seen[0].sql, /RETURNING/);
  assert.notEqual(key.revokedAt, null);
});

test("a key id this workspace does not have is refused, and is its own error class", async () => {
  // Zero rows is the ONLY answer a foreign or invented id can get, because the
  // workspace is in the WHERE clause — the refusal is the SQL, not a check a
  // caller could skip (D148).
  const { query } = recordingQuery([]);
  await assert.rejects(revokeApiKey("ws_b", "key_0011223344556677", query), (error: unknown) => {
    assert.ok(error instanceof UnknownApiKey);
    assert.equal((error as Error).name, "UnknownApiKey");
    // the id is quoted into the message for the operator's log, and the message
    // is never what the surface renders — `settings/errors.ts` owns the words
    assert.equal(settingsErrorCode(error), "key-not-found");
    return true;
  });
});

// ---- D68 (by rule): the name is a total parse ----

test("D68 totality: no hostile name throws, and nothing outside the bound is stored", () => {
  const named = ["collector", "  collector  ", "a", "x".repeat(KEY_NAME_MAX)];
  assert.equal(parseKeyName("  collector  "), "collector", "the stored name is trimmed (D138)");
  for (const value of named) {
    const parsed = parseKeyName(value);
    assert.ok(parsed !== null && parsed.length >= 1 && parsed.length <= KEY_NAME_MAX, value);
  }

  for (const value of HOSTILE_URL_VALUES) {
    const parsed = ((): string | null => {
      try {
        return parseKeyName(value);
      } catch (error) {
        assert.fail(`parseKeyName threw ${String(error)} — a form parse must never throw (D68)`);
      }
    })();
    if (parsed !== null) {
      // in-domain: a trimmed string inside D138's bound, never the caller's
      // 5000-character value carried forward into a NOT NULL column
      assert.equal(parsed, parsed.trim());
      assert.ok(parsed.length >= 1 && parsed.length <= KEY_NAME_MAX, JSON.stringify(parsed));
    }
  }

  // named refusals, so the loop above cannot go green by a parse that answers
  // null to everything — a prototype name IS a valid key name, because a name is
  // only ever bound as a parameter and never used for a property lookup
  assert.equal(parseKeyName("toString"), "toString");
  assert.equal(parseKeyName("__proto__"), "__proto__");
  for (const refused of ["", "   ", "\t\n", "x".repeat(KEY_NAME_MAX + 1)]) {
    assert.equal(parseKeyName(refused), null, `accepted ${JSON.stringify(refused)}`);
  }
  // FormData answers `null` for an absent field and a File for an upload
  for (const refused of [null, undefined, 7, {}, []]) {
    assert.equal(parseKeyName(refused), null, `accepted ${JSON.stringify(refused)}`);
  }
  // a repeated field hands over an array; the first member is judged
  assert.equal(parseKeyName([" collector ", "second"]), "collector");
});

// ---- D121/D129/D133: the settings vocabulary ----

test("D121: every code has copy, and the code itself is never the message", () => {
  for (const [code, copy] of Object.entries(SETTINGS_ERRORS)) {
    assert.equal(settingsErrorMessage(code), copy);
    assert.equal(copy.includes(code), false, `the code leaked into its own copy: ${code}`);
    assert.match(copy, /[.!]$/, `settings copy is a sentence: ${copy}`);
  }
  // D13/D140: settings copy may not promise a feature this product does not have
  for (const copy of Object.values(SETTINGS_ERRORS)) {
    assert.doesNotMatch(copy, /soon|will be able|coming/i, `settings copy promises a feature: ${copy}`);
  }
  // ...and the two an inviter really hits say what already exists rather than
  // "try again" about a retry that would fail identically (D129)
  assert.match(SETTINGS_ERRORS["invite-member-exists"], /already a member/i);
  assert.match(SETTINGS_ERRORS["invite-pending"], /already has an open invite/i);
});

test("D121: absent means no message; another surface's code is just an unknown code", () => {
  assert.equal(settingsErrorMessage(undefined), null);
  assert.equal(settingsErrorMessage("exists"), SETTINGS_ERRORS["settings-failed"]);
  assert.equal(settingsErrorMessage("not-recipient"), SETTINGS_ERRORS["settings-failed"]);
});

test("D68 totality: no hostile ?error= value throws, escapes the vocabulary, or reaches the page", () => {
  // The settings surface joins the corpus BY RULE (`lib/hostile-url-values.ts`):
  // a new `?error=` vocabulary is a new reader run against the same values, not
  // a corpus of its own.
  const copy = Object.values(SETTINGS_ERRORS) as string[];
  for (const value of HOSTILE_URL_VALUES) {
    const where = `settings?error=${Array.isArray(value) ? value.join(",") : value.slice(0, 20)}`;

    const message = ((): string | null => {
      try {
        return settingsErrorMessage(value);
      } catch (error) {
        assert.fail(`${where} threw ${String(error)} — a URL parse must never throw (D68)`);
      }
    })();

    assert.ok(typeof message === "string", `${where} produced ${String(message)} instead of copy`);
    assert.ok(copy.includes(message), `${where} escaped the vocabulary: ${JSON.stringify(message)}`);

    const needle = Array.isArray(value) ? value[0] : value;
    if (needle.length > 0) {
      assert.ok(!message.includes(needle), `${where} reflected its own value into the page`);
    }
  }
});

/**
 * Every library-code arm on the settings surface. Pinned as STRINGS because
 * better-auth does not export its code maps: `better-auth/plugins/organization`
 * exports getOrgAdapter, hasPermission, organization, parseRoles, and
 * `./plugins/organization/error-codes` is not a subpath in the package's
 * `exports` at all (both measured at 1.7.1) — so the three literals below are
 * transcribed from the installed dist rather than imported from it:
 * `dist/plugins/organization/error-codes.mjs:13,:23` and
 * `@better-auth/core/dist/error/codes.mjs:10`, each wrapped by
 * `defineErrorCodes` into `{code: <the KEY>, message: <the sentence>}` and
 * carried into `body.code` by `APIError.from` — the field `settingsErrorCode`
 * reads.
 *
 * What no suite does: drive `createInvitation` into these three failures. The
 * arms are measured against the dist, not against a live endpoint, and the
 * transcription is the risk an upgrade carries here (`invites.integration.test.ts`
 * drives the real endpoint for the ACCEPT surface's own vocabulary, which is a
 * different set of codes).
 */
const SETTINGS_ARMS: ReadonlyArray<[string, SettingsErrorCode]> = [
  ["INVALID_EMAIL", "invite-email-invalid"],
  ["USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION", "invite-member-exists"],
  ["USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION", "invite-pending"],
];

/** The errors are REAL `APIError`s: the mapping keys off `name`, and only the class proves it. */
const apiError = (code: string, message = "") => new APIError("BAD_REQUEST", { code, message });

/**
 * The other three arms are OURS — the error classes this codebase throws, one
 * from the keys store and two from the ingest-health store (D182 put all three
 * refusals in the one settings vocabulary). Real instances for the same reason
 * the `APIError` table builds real ones: `settingsErrorCode` matches on `name`
 * so that `errors.ts` imports no error class, and only an object carrying the
 * real `name` proves that match. The names themselves are pinned beside their
 * classes (`ingest-health.test.ts`), so a rename is red in two places.
 */
const OWN_ARMS: ReadonlyArray<[Error, SettingsErrorCode]> = [
  [new UnknownApiKey("key_0011223344556677"), "key-not-found"],
  [new OverrideLimit(), "override-limit"],
  [new UnknownOverride("ovr_x"), "override-not-found"],
];

test("D133: every settings arm maps directly, from a real instance", () => {
  assert.equal(SETTINGS_ARMS.length, 3, "an arm was added or removed without a direct assertion");
  for (const [code, expected] of SETTINGS_ARMS) {
    assert.equal(settingsErrorCode(apiError(code)), expected, `settings arm ${code}`);
  }

  assert.equal(OWN_ARMS.length, 3, "an arm was added or removed without a direct assertion");
  for (const [error, expected] of OWN_ARMS) {
    assert.equal(settingsErrorCode(error), expected, `settings arm ${error.name}`);
  }
});

test("D133 totality: any code outside the arms lands on the generic member", () => {
  const armed = new Set(SETTINGS_ARMS.map(([code]) => code));
  const corpus = [
    // real organization-plugin codes `createInvitation` and `cancelInvitation`
    // can raise that this surface deliberately does not name — an owner inviting
    // into her own org can do nothing differently about any of them
    "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
    "YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE",
    "YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION",
    "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED",
    "MEMBER_NOT_FOUND",
    "ORGANIZATION_NOT_FOUND",
    "INVITATION_NOT_FOUND",
    // and the other surfaces' answers, which must not become settings copy
    "USER_ALREADY_EXISTS",
    "PASSWORD_TOO_SHORT",
    "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
    ...SETTINGS_ARMS.map(([code]) => code),
    ...HOSTILE_URL_VALUES.filter((v): v is string => typeof v === "string"),
  ];
  // S2.0 L1: a loop over a shrunken corpus is green by vacuity. 10 library codes
  // + 3 arms + 14 hostile strings (the fifteenth D68 entry is the repeated-
  // parameter ARRAY, which a `body.code` never is, so `filter` drops it).
  assert.equal(corpus.length, 27, "the totality corpus changed size — re-check both lists");

  for (const code of corpus) {
    if (!armed.has(code)) assert.equal(settingsErrorCode(apiError(code)), "settings-failed", code);
  }

  // ...and anything that is not an error the mapping recognises at all — a dead
  // pool, a thrown string, an object wearing the name — is the generic too
  for (const notApi of [
    new Error("connection terminated unexpectedly"),
    { name: "APIError" },
    { name: "UnknownApiKey!" },
    { body: { code: "INVALID_EMAIL" } },
    "INVALID_EMAIL",
    null,
    undefined,
  ]) {
    assert.equal(settingsErrorCode(notApi), "settings-failed", JSON.stringify(notApi));
  }
});
