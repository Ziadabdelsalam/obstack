import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import {
  UnknownApiKey,
  generateToken,
  hashToken,
  issueApiKey,
  keyPrefix,
  listApiKeys,
  revokeApiKey,
  resolveApiKey,
} from "./api-keys";
import { getPool, queryRows } from "./postgres";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait postgres ingest
// then:     OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//           npm test --workspace apps/web
//
// The three claims this task cannot make without real rows (D130):
//
//   1. SHOWN ONCE is a fact about storage — the row an issued key leaves behind
//      contains the token nowhere, in no column, so nothing can reproduce it.
//   2. The hash contract really is the one ingest reads: the continuity row that
//      `0004_api_keys.sql` seeded (written by the migration, hashed by nobody in
//      this process) equals `hashToken("ok_dev_local")` equals the pinned D139
//      vector — three independent measurements of one value.
//   3. A revoke issued for one workspace cannot reach another's key, asserted by
//      CONTENT (S3.1 L1): the refusal is proven not to have written, and the
//      same call by the owning workspace is proven to work.
//
// `api-keys.test.ts` proves the predicates are in the SQL with no Postgres at
// all; this file proves Postgres agrees.
//
// D130's skip class, deliberately NARROW: this file self-skips only when
// `OBSTACK_TEST_POSTGRES_DSN` is UNSET. It does not probe for reachability — a
// DSN naming a dead port or an unmigrated database FAILS here, loudly, naming
// what it dialled, because an integration test with a DSN never degrades to a
// pass. The schema is NOT applied here: `services/ingest/pgmigrations/*.sql`
// applied by the ingest binary's migrator is the ONE schema path (K1).

const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;

const skip = DSN
  ? undefined
  : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";

// `postgres.ts` builds its pool lazily on the first query (D114), so pointing the
// app's own read path at the test DSN here is enough: everything below goes
// through `queryRows`, the same parameterized path the settings actions use.
if (DSN) process.env.OBSTACK_POSTGRES_DSN = DSN;

/** host:port of the DSN, for failure messages — never its password. */
function target(): string {
  try {
    const url = new URL(DSN as string);
    return `${url.host}${url.pathname}`;
  } catch {
    return "the configured DSN";
  }
}

after(async () => {
  // An idle pg pool holds the event loop open and the runner would never exit.
  if (DSN) await getPool().end();
});

/**
 * A fresh pair of workspaces for one test, dropped afterwards. The ids carry a
 * random suffix because CI runs this against the compose Postgres a signup drive
 * also writes to: a fixed id would collide with a rerun and a global DELETE
 * would take somebody else's rows with it.
 */
async function withWorkspacePair(run: (a: string, b: string) => Promise<void>): Promise<void> {
  const tag = randomBytes(6).toString("hex");
  const a = `ws_t3a_${tag}`;
  const b = `ws_t3b_${tag}`;
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2), ($3, $4)`, [
    a,
    `org_t3a_${tag}`,
    b,
    `org_t3b_${tag}`,
  ]);
  try {
    await run(a, b);
  } finally {
    // ON DELETE CASCADE takes the keys with them (D138) — asserted below.
    await queryRows(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [a, b]);
  }
}

/** Rows in the table for one workspace, counted directly rather than through the store. */
async function rowCount(workspaceId: string): Promise<number> {
  const [row] = await queryRows<{ n: string }>(
    `SELECT count(*)::text AS n FROM api_keys WHERE workspace_id = $1`,
    [workspaceId],
  );
  return Number(row.n);
}

/**
 * INGEST'S LOOKUP, verbatim (D146): the statement `internal/keystore` runs, in
 * this file, so "the web half issues what the Go half resolves" is a fact about
 * the same query rather than about two descriptions of one.
 */
const KEYSTORE_LOOKUP_SQL = `SELECT workspace_id FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL AND scope = 'ingest'`;

const resolveToken = (token: string) =>
  queryRows<{ workspace_id: string }>(KEYSTORE_LOOKUP_SQL, [hashToken(token)]);

/** The whole row as text, so "the token is nowhere in it" can be a claim about ALL of it. */
async function wholeRow(keyId: string): Promise<string> {
  const [row] = await queryRows<{ json: string }>(
    `SELECT to_jsonb(k)::text AS json FROM api_keys k WHERE id = $1`,
    [keyId],
  );
  return row.json;
}

test("the DSN this run was given answers, and it holds the migrated schema", { skip }, async () => {
  // First contact. A refused connection or a missing table surfaces HERE, with
  // the address in the message, instead of as a puzzling failure inside a
  // property test — and never as a skip.
  try {
    assert.equal(await rowCount(`ws_t3_absent_${randomBytes(4).toString("hex")}`), 0);
  } catch (error) {
    assert.fail(
      `OBSTACK_TEST_POSTGRES_DSN is set but ${target()} did not answer a read of api_keys — ` +
        `an integration test with a DSN never degrades to a pass; apply ` +
        `services/ingest/pgmigrations in filename order and check the port: ${String(error)}`,
    );
  }
});

test("D139: the seeded continuity row IS this module's hash of the published preimage", { skip }, async () => {
  // The cross-language seam, measured rather than described. Nothing in this
  // process wrote that row: `0004_api_keys.sql` did, applied by the Go migrator,
  // carrying a literal an advisor pinned. If the two hash contracts ever
  // disagree — a different encoding, a salt, a trimmed token — this is where it
  // surfaces, before an issued key silently stops resolving at ingest.
  const [row] = await queryRows<{ workspace_id: string; prefix: string; token_hash: string }>(
    `SELECT workspace_id, prefix, token_hash FROM api_keys WHERE id = $1`,
    ["key_dev_local"],
  );
  assert.ok(
    row,
    "no key_dev_local row — 0004_api_keys.sql's continuity seed is what keeps the collector, " +
      "the compose harnesses and every signed evidence run authenticating (D138)",
  );

  assert.equal(row.token_hash, hashToken("ok_dev_local"));
  assert.equal(row.token_hash, "45880674fdc48bbcd49721bf6ac190e804836ca4fcd54c736c604153f4947e20");
  // the prefix rule is one rule for both shapes: token[0:12], which for the dev
  // credential is the whole token — honestly, it is published in a README
  assert.equal(row.prefix, keyPrefix("ok_dev_local"));
  assert.equal(row.workspace_id, "ws_demo");

  // ...and the lookup ingest actually runs finds it from the token alone
  assert.deepEqual(await resolveToken("ok_dev_local"), [{ workspace_id: "ws_demo" }]);
});

test("shown once: the stored row cannot reproduce the token", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const { token, key } = await issueApiKey(a, "collector", "ingest", queryRows);
    assert.match(token, /^ok_live_[0-9a-f]{64}$/);

    // Every byte the row holds, as text. The token is not in it — not whole, not
    // its secret tail, not encoded into some column that "only" holds a prefix.
    const stored = await wholeRow(key.id);
    assert.equal(stored.includes(token), false, "the token is recoverable from its own row");
    assert.equal(stored.includes(token.slice(12)), false, "the token's tail is in the row");
    assert.ok(stored.includes(hashToken(token)), "the row must hold the hash — this probe is inert otherwise");
    assert.ok(stored.includes(keyPrefix(token)), "the display prefix is stored, and is 12 characters");

    // The falsification: a SEARCH of the whole table by the token finds nothing,
    // while the same search by its hash finds exactly this key. That is the
    // difference between "shown once" and a screen that hides a column.
    assert.deepEqual(
      await queryRows(`SELECT id FROM api_keys k WHERE to_jsonb(k)::text LIKE $1`, [`%${token}%`]),
      [],
    );
    assert.deepEqual(await queryRows(`SELECT id FROM api_keys WHERE token_hash = $1`, [hashToken(token)]), [
      { id: key.id },
    ]);
  });
});

test("an issued key resolves to ITS workspace through ingest's lookup, and to no other", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    // Content-aware (S3.1 L1): the two workspaces are asserted to be different
    // real values first, so "resolved to its own" cannot be green because both
    // sides happen to be the same string.
    assert.notEqual(a, b);
    assert.ok(a.length > 0 && b.length > 0);

    const mine = await issueApiKey(a, "collector", "ingest", queryRows);
    const theirs = await issueApiKey(b, "collector", "ingest", queryRows);
    assert.notEqual(mine.token, theirs.token);

    assert.deepEqual(await resolveToken(mine.token), [{ workspace_id: a }]);
    assert.deepEqual(await resolveToken(theirs.token), [{ workspace_id: b }]);
    // an issued-shaped token that was never issued resolves to nothing at all —
    // the unknown-key 401 ingest answers with (D6/D146)
    assert.deepEqual(await resolveToken(generateToken()), []);

    // and the list is disjoint by rows, not merely by what the read path returned
    assert.deepEqual((await listApiKeys(a, queryRows)).map((k) => k.id), [mine.key.id]);
    assert.deepEqual((await listApiKeys(b, queryRows)).map((k) => k.id), [theirs.key.id]);
    assert.equal(await rowCount(a), 1);
    assert.equal(await rowCount(b), 1);
  });
});

test("a revoke issued for one workspace cannot reach the other's key", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const mine = await issueApiKey(a, "collector", "ingest", queryRows);

    await assert.rejects(
      revokeApiKey(b, mine.key.id, queryRows),
      (error: unknown) => error instanceof UnknownApiKey,
      "another workspace revoked a key it does not own",
    );

    // By CONTENT, not by the absence of a throw: the row is untouched and the
    // key still authenticates through ingest's own lookup.
    assert.deepEqual(
      await queryRows(`SELECT revoked_at FROM api_keys WHERE id = $1`, [mine.key.id]),
      [{ revoked_at: null }],
      "the refused revoke reached the row anyway",
    );
    assert.deepEqual(await resolveToken(mine.token), [{ workspace_id: a }]);

    // Control: the same call from the OWNING workspace works — so the refusal
    // above is about the workspace and not about a call that could never work.
    const revoked = await revokeApiKey(a, mine.key.id, queryRows);
    assert.ok(revoked.revokedAt instanceof Date);
    assert.deepEqual(await resolveToken(mine.token), [], "a revoked key still resolves");

    // Revoking again keeps the first revocation's timestamp and stays scoped:
    // idempotent for the owner, still refused for the stranger.
    const again = await revokeApiKey(a, mine.key.id, queryRows);
    assert.equal(again.revokedAt?.getTime(), revoked.revokedAt?.getTime());
    await assert.rejects(revokeApiKey(b, mine.key.id, queryRows), (e: unknown) => e instanceof UnknownApiKey);

    // ...and the revoked key is still LISTED, because a key that stopped working
    // is a thing an operator needs to see.
    assert.deepEqual(
      (await listApiKeys(a, queryRows)).map((k) => [k.id, k.revokedAt !== null]),
      [[mine.key.id, true]],
    );
  });
});

test("one token can never name two workspaces (the UNIQUE that IS the lookup index)", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const { token } = await issueApiKey(a, "collector", "ingest", queryRows);
    // The hash column's UNIQUE is what makes ingest's single-row lookup a
    // tenancy guarantee rather than a convention: the same credential cannot be
    // planted in a second workspace, by us or by anyone with an INSERT.
    await assert.rejects(
      queryRows(
        `INSERT INTO api_keys (workspace_id, name, prefix, token_hash, id) VALUES ($1, $2, $3, $4, $5)`,
        [b, "stolen", keyPrefix(token), hashToken(token), `key_${randomBytes(8).toString("hex")}`],
      ),
      /duplicate key value|api_keys_token_hash_key/,
    );
    assert.deepEqual(await resolveToken(token), [{ workspace_id: a }]);
    assert.equal(await rowCount(b), 0);
  });
});

test("S8.1 D642/D644: ingest's door refuses read and setup keys; the MCP door admits exactly those two", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const ingest = await issueApiKey(a, "exporter", "ingest", queryRows);
    const read = await issueApiKey(a, "agent", "read", queryRows);
    const setup = await issueApiKey(a, "agent-setup", "setup", queryRows);
    assert.deepEqual([ingest.key.scope, read.key.scope, setup.key.scope], ["ingest", "read", "setup"]);

    // Ingest's lookup, verbatim: only the ingest key resolves there.
    assert.deepEqual(await resolveToken(ingest.token), [{ workspace_id: a }]);
    assert.deepEqual(await resolveToken(read.token), [], "a read key opened the ingest door");
    assert.deepEqual(await resolveToken(setup.token), [], "a setup key opened the ingest door");

    // The MCP door: the two agent scopes, with the scope reported; never ingest.
    assert.deepEqual(await resolveApiKey(read.token, queryRows), { keyId: read.key.id, workspaceId: a, scope: "read" });
    assert.deepEqual(await resolveApiKey(setup.token, queryRows), { keyId: setup.key.id, workspaceId: a, scope: "setup" });
    assert.equal(await resolveApiKey(ingest.token, queryRows), null, "an ingest key opened the MCP door");
    assert.equal(await resolveApiKey(generateToken(), queryRows), null);

    // Revocation closes the MCP door too, through the same predicate.
    await revokeApiKey(a, read.key.id, queryRows);
    assert.equal(await resolveApiKey(read.token, queryRows), null, "a revoked read key still opens the MCP door");

    // The list shows the scope beside every key, revoked ones included.
    const listed = await listApiKeys(a, queryRows);
    assert.deepEqual(
      listed.map((k) => [k.name, k.scope]).sort(),
      [["agent", "read"], ["agent-setup", "setup"], ["exporter", "ingest"]],
    );
  });
});

test("dropping a workspace takes its keys with it (D138's in-set foreign key)", { skip }, async () => {
  const tag = randomBytes(6).toString("hex");
  const doomed = `ws_t3c_${tag}`;
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2)`, [doomed, `org_t3c_${tag}`]);
  const { token } = await issueApiKey(doomed, "collector", "ingest", queryRows);
  assert.equal(await rowCount(doomed), 1);

  await queryRows(`DELETE FROM workspaces WHERE id = $1`, [doomed]);
  // No orphan credentials left behind: a key authorises writes into a workspace,
  // and a workspace that is gone must not still have a key that names it.
  assert.equal(await rowCount(doomed), 0);
  assert.deepEqual(await resolveToken(token), []);
});
