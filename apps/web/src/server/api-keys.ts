import "server-only";
import { createHash, randomBytes } from "node:crypto";
import {
  API_KEY_SCOPES,
  DEFAULT_API_KEY_SCOPE,
  MCP_ADMITTED_SCOPES,
  type ApiKeyScope,
  type McpKeyScope,
} from "@/lib/mcp-types";
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
 *
 * S8.1 (D642/D644): a key carries a SCOPE — `ingest`, `read` or `setup`, the
 * vocabulary `0014_api_key_scope.sql` owns and `lib/mcp-types.ts` mirrors — and
 * this module gains the ONE statement in it that does not bind a workspace:
 * `resolveApiKey`, the MCP endpoint's door. There the workspace is the OUTPUT
 * and the hash is the owner pin, in the direction ingest's keystore already runs
 * it (`internal/keystore/store.go`'s lookupSQL, with the other two scopes).
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
  scope: ApiKeyScope;
  createdAt: Date;
  revokedAt: Date | null;
}

/** What the MCP door resolves a bearer token to (D642): never an `ingest` key. */
export interface ResolvedApiKey {
  keyId: string;
  workspaceId: string;
  scope: McpKeyScope;
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

/**
 * The scope, as a total parse (D68 by rule), beside `parseKeyName` for the same
 * form: absent or empty means the DEFAULT (`ingest`, what every key was before
 * 0014), a member of the vocabulary means itself, and anything else is `null` —
 * the caller's error code, never a value the CHECK gets to refuse as a 500.
 */
export function parseKeyScope(raw: unknown): ApiKeyScope | null {
  // Absent (FormData.get's null, an unset field) or blank means the default.
  if (raw === undefined || raw === null || raw === "") return DEFAULT_API_KEY_SCOPE;
  // A repeated field takes its first value (parseKeyName's rule); an EMPTY
  // array is not absence, it is a shape no form produces — not a scope.
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  if (value === "") return DEFAULT_API_KEY_SCOPE;
  return (API_KEY_SCOPES as readonly string[]).includes(value) ? (value as ApiKeyScope) : null;
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
  SELECT id, name, prefix, scope, created_at, revoked_at
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
  INSERT INTO api_keys (workspace_id, name, prefix, token_hash, id, scope)
       VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, name, prefix, scope, created_at, revoked_at`;

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
  RETURNING id, name, prefix, scope, created_at, revoked_at`;

/**
 * THE MCP DOOR (D642): ingest's `lookupSQL` restated with the scopes the
 * endpoint admits — bound as a parameter from `MCP_ADMITTED_SCOPES`, so the
 * constant is the authority and this text never lists a scope. Unknown,
 * revoked and `ingest`-scoped tokens all match zero rows: one predicate, one
 * absent answer, no key-probing oracle (D6). The workspace is what comes OUT.
 */
const RESOLVE_SQL = `
  SELECT id, workspace_id, scope
    FROM api_keys
   WHERE token_hash = $1 AND revoked_at IS NULL AND scope = ANY($2::text[])`;

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  scope: ApiKeyScope;
  created_at: Date;
  revoked_at: Date | null;
};

const toApiKey = (row: KeyRow): ApiKey => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  scope: row.scope,
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
 * function may quietly trim into shape. The scope likewise (`parseKeyScope`):
 * the quickstart passes `ingest` by definition, the settings picker whatever
 * the operator chose, and the MCP mint (D666) always `ingest`.
 */
export async function issueApiKey(
  workspaceId: string,
  name: string,
  scope: ApiKeyScope,
  query: QueryRows,
): Promise<IssuedApiKey> {
  const token = generateToken();
  const [row] = await query<KeyRow>(INSERT_SQL, [
    workspaceId,
    name,
    keyPrefix(token),
    hashToken(token),
    newId(),
    scope,
  ]);
  return { token, key: toApiKey(row) };
}

/**
 * Resolve a bearer token at the MCP door (D642): the hash, looked up once, with
 * only the admitted scopes — `null` for unknown, revoked and `ingest`-scoped
 * alike, and the caller answers every `null` with the same 401. No cache
 * (D642's reason: the reads that follow cost more than this lookup, and a cache
 * is a second copy of ingest's fail-static policy that this path has no outage
 * story for).
 */
export async function resolveApiKey(token: string, query: QueryRows): Promise<ResolvedApiKey | null> {
  const [row] = await query<{ id: string; workspace_id: string; scope: McpKeyScope }>(RESOLVE_SQL, [
    hashToken(token),
    [...MCP_ADMITTED_SCOPES],
  ]);
  return row ? { keyId: row.id, workspaceId: row.workspace_id, scope: row.scope } : null;
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
