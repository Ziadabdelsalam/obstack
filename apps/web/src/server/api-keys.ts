import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { QueryRows } from "@/server/postgres";

/**
 * API keys: the credential a client sends as `Authorization: Bearer <token>`,
 * and the row that names the workspace every record in that request is written
 * into (D98/D138). This module is the WEB half of a contract two languages
 * implement — it issues, lists and revokes; `services/ingest/internal/keystore`
 * reads the same rows with the same hash — so everything below that ingest also
 * computes is stated once, here, and pinned to a cross-language test vector in
 * `api-keys.test.ts` (D139).
 *
 * The token is shown ONCE and never persisted. What the row holds is the
 * SHA-256 of the full token string, so a database dump is not a credential dump
 * and "shown once" is a fact about storage rather than a screen that hides a
 * column. There is no per-row salt: the token carries 256 bits of CSPRNG output,
 * so there is nothing to precompute against, and a KDF would land on ingest's
 * hot path (D98). `api-keys.integration.test.ts` proves the stored row cannot
 * reproduce the token, against real rows.
 *
 * The workspace is a PARAMETER and never ambient, the same rule the saved-views
 * store keeps (D113): every statement binds it as `$1` and names `workspace_id`
 * in its text, and the caller fills it from `SessionContext` on the server
 * (`app/app/settings/actions.ts`) — no caller-supplied workspace id exists
 * anywhere on this path (D148: authorization IS the owner pin).
 */

/** The one issued shape (D139). Ingest never validates it — it hashes and looks up. */
export const KEY_TOKEN_PREFIX = "ok_live_";

/** Bytes of CSPRNG entropy behind a token: 32 → 64 hex characters → 256 bits. */
const TOKEN_BYTES = 32;

/** The display prefix is `token[0:12]` — the same rule for every shape (D139). */
export const KEY_PREFIX_LENGTH = 12;

/** D138's app-side bound on the name, stated once and enforced by the parse. */
export const KEY_NAME_MAX = 100;

/** A key as the settings surface lists it — everything about it except the secret. */
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  revokedAt: Date | null;
}

/** What issuing answers with: the token, once, beside the row that will outlive it. */
export interface IssuedApiKey {
  token: string;
  key: ApiKey;
}

/**
 * A revoke that named a key this workspace does not have. Its own class rather
 * than a message, so `settings/errors.ts` can map it without matching on prose
 * and without importing this server-only module (`SignupError`'s precedent).
 */
export class UnknownApiKey extends Error {
  constructor(keyId: string) {
    super(`no key ${JSON.stringify(keyId)} in this workspace`);
    this.name = "UnknownApiKey";
  }
}

/**
 * The hash contract, both languages: SHA-256 over the UTF-8 bytes of the exact
 * full token string, lowercase hex (D139). `update(token, "utf8")` is that
 * encoding named rather than left to node's default, because the default is what
 * would silently change the answer for a non-ASCII preimage — pinned in the unit
 * suite against a vector computed outside this process.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** `ok_live_` + 64 lowercase hex characters from 32 CSPRNG bytes (D139). */
export function generateToken(): string {
  return `${KEY_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("hex")}`;
}

/**
 * Display only, and safe to store: the first 12 characters of the token. For an
 * `ok_live_` token that is the class marker plus four hex characters — enough to
 * recognise a key in a list, far too little to spend.
 */
export function keyPrefix(token: string): string {
  return token.slice(0, KEY_PREFIX_LENGTH);
}

/**
 * The name, as a total parse (D68 by rule): it arrives on a server action's
 * FormData, so it may be absent, repeated, empty, 5000 characters or hostile.
 * `null` means "not a name" and is the caller's error code; anything else is a
 * trimmed string inside D138's 1–100 bound, which is the only thing that ever
 * reaches the NOT NULL column.
 */
export function parseKeyName(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > KEY_NAME_MAX) return null;
  return trimmed;
}

const newId = (): string => `key_${randomBytes(8).toString("hex")}`;

/**
 * Every statement binds the workspace as `$1` and names `workspace_id` in its
 * text — asserted for every call this module makes in `api-keys.test.ts`, so a
 * predicate dropped here goes red instead of listing or revoking sideways.
 *
 * The revoked keys stay in the list: a key that stopped working is a thing an
 * operator needs to see, and the ingest lookup filters them out by itself
 * (D146's `revoked_at IS NULL`).
 */
const LIST_SQL = `
  SELECT id, name, prefix, created_at, revoked_at
    FROM api_keys
   WHERE workspace_id = $1
   ORDER BY created_at, id`;

/**
 * `workspace_id` leads the column list so it can lead the bindings. The row is
 * read back with RETURNING rather than assembled locally, so the list shows what
 * Postgres holds — including `created_at`, which is the server's clock and not
 * this process's.
 */
const INSERT_SQL = `
  INSERT INTO api_keys (workspace_id, name, prefix, token_hash, id)
       VALUES ($1, $2, $3, $4, $5)
    RETURNING id, name, prefix, created_at, revoked_at`;

/**
 * Revocation is idempotent and scoped: `coalesce` keeps the FIRST revocation's
 * timestamp, so re-revoking a revoked key changes nothing and still RETURNS its
 * row. That is what makes zero rows mean exactly one thing — the key is not this
 * workspace's — instead of conflating "already revoked" with "someone else's".
 */
const REVOKE_SQL = `
  UPDATE api_keys
     SET revoked_at = coalesce(revoked_at, now())
   WHERE workspace_id = $1 AND id = $2
  RETURNING id, name, prefix, created_at, revoked_at`;

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  created_at: Date;
  revoked_at: Date | null;
};

const toApiKey = (row: KeyRow): ApiKey => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.created_at,
  revokedAt: row.revoked_at,
});

/** This workspace's keys, oldest first, revoked ones included. */
export async function listApiKeys(workspaceId: string, query: QueryRows): Promise<ApiKey[]> {
  const rows = await query<KeyRow>(LIST_SQL, [workspaceId]);
  return rows.map(toApiKey);
}

/**
 * Issue one. The token is generated, hashed and dropped: it exists in this
 * process for the length of one call and in the response that carries it back,
 * and the only thing that touches Postgres is its hash and its first twelve
 * characters. There is no code path that can read it out of a row afterwards —
 * that is the whole of "shown once".
 *
 * The name is already parsed by the caller (`parseKeyName`), because a blank or
 * over-long name is an error code the surface shows and not a value this
 * function may quietly trim into shape.
 */
export async function issueApiKey(
  workspaceId: string,
  name: string,
  query: QueryRows,
): Promise<IssuedApiKey> {
  const token = generateToken();
  const [row] = await query<KeyRow>(INSERT_SQL, [
    workspaceId,
    name,
    keyPrefix(token),
    hashToken(token),
    newId(),
  ]);
  return { token, key: toApiKey(row) };
}

/**
 * Revoke one of THIS workspace's keys. A key id from another workspace is
 * refused here and never becomes an UPDATE anyone else can see — the settings
 * action is reachable by direct POST (Next's own warning), so the workspace in
 * the WHERE clause is the whole authorization (D148).
 */
export async function revokeApiKey(
  workspaceId: string,
  keyId: string,
  query: QueryRows,
): Promise<ApiKey> {
  const [row] = await query<KeyRow>(REVOKE_SQL, [workspaceId, keyId]);
  if (!row) throw new UnknownApiKey(keyId);
  return toApiKey(row);
}
