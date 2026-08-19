import "server-only";
import { randomBytes } from "node:crypto";
import { lockWorkspace, type QueryRows, type TxQuery } from "@/server/postgres";
import priceList from "../../../../services/ingest/pricing/prices.json";

/**
 * What the Data & ingest tab reads and writes: the per-key health rows the
 * ingest flusher keeps (D100/D162) and this workspace's pricing overrides
 * (D108). Both are rows two languages share — Go writes the health rows and
 * reads the override rows, this module reads the health rows and writes the
 * override rows — so everything below that ingest also computes is stated here
 * against ingest's own definition rather than re-invented.
 *
 * The health rows are the LIVENESS surface D138 refused to put on `api_keys`:
 * no `last_used_at` column was ever added, because the authenticated read path
 * must not write. What an operator sees here is written by the metering flush
 * (D166) on its own interval, which is why every number on this page carries an
 * "as of" and why that "as of" is `api_key_health.updated_at` and nothing else.
 *
 * Read-only where it reads and `$`-bound everywhere (D11): the workspace is a
 * parameter in every statement, `queryRows` is INJECTED rather than imported
 * (the D113 pattern), and no caller-supplied workspace id exists on this path —
 * the action fills it from the session (D148).
 */

/**
 * The embedded price list, imported from the ONE file the ingest binary embeds
 * (`services/ingest/pricing/prices.json`) rather than restated here. Two copies
 * of the date would be the S2.3 L3 divergence class applied to the one number
 * whose whole job is to say how old our prices are (D29): a tab claiming the
 * list was checked on a date the binary has never heard of is worse than no
 * date at all.
 *
 * The path leaves `apps/web`, which resolves because the bundler's root is the
 * repo (`next.config.ts` sets `turbopack.root` two levels up) — the same
 * workspace both halves of the product are built from. Only the date and the
 * row count cross into the bundle; the rates themselves are ingest's business
 * and are never priced or re-derived on this side.
 */
export const BASE_PRICES_AS_OF: string = priceList.as_of;

/** How many model prefixes that list prices — shown so "everything else" has a size. */
export const BASE_PRICES_COUNT: number = priceList.prices.length;

/**
 * D164(f)'s app-side bound: the workspace map in ingest's keystore holds every
 * workspace's built price table, and override rows are the only thing that
 * grows it. A hundred per workspace keeps the worst case at tens of megabytes
 * with no second bound constant anywhere — enforced in the INSERT below, and
 * stated to the operator in the form error rather than only in a comment.
 */
export const OVERRIDE_MAX = 100;

/**
 * A match is a model-name prefix (D9), and the longest one wins. Two hundred
 * characters is far longer than any model name anyone has shipped and short
 * enough that a hostile paste cannot become a row.
 */
export const OVERRIDE_MATCH_MAX = 200;

/**
 * Dollars per million tokens. The ceiling is not a business rule — it is the
 * line past which a number is a typo rather than a price, and a typo that
 * reaches this table misprices every span of that model until someone notices.
 */
export const PRICE_PER_MTOK_MAX = 10_000;

/** One key's health, as the tab lists it. `asOf` is null until the flusher writes a row. */
export interface KeyHealth {
  keyId: string;
  name: string;
  prefix: string;
  revoked: boolean;
  accepted: number;
  droppedDecode: number;
  droppedUnsupported: number;
  droppedQuota: number;
  lastEventAt: Date | null;
  asOf: Date | null;
}

/**
 * The workspace's ingest health: its keys, and the three totals the exit
 * criterion asks to be visible.
 *
 * `receiveErrors` is decode plus unsupported and deliberately NOT quota drops:
 * a sampled-out trace is degradation the customer's plan bought, not a fault in
 * their instrumentation, and summing the two would tell an operator their
 * exporter is broken when it is working exactly as designed. The basis is
 * stated on the surface for the same reason D162 gives — write-path drops are
 * not in these rows at all (the writer knows the workspace, not the key), so
 * this count is receive-path errors and says so.
 */
export interface WorkspaceIngestHealth {
  keys: KeyHealth[];
  accepted: number;
  receiveErrors: number;
  droppedQuota: number;
  /** The freshest health row's `updated_at` — the one staleness statement (D162). */
  asOf: Date | null;
}

/** One override row, the D9 row shape with a workspace on it (D108). */
export interface PricingOverride {
  id: string;
  match: string;
  inputPerMTok: number;
  outputPerMTok: number;
  updatedAt: Date;
}

/**
 * The workspace already holds `OVERRIDE_MAX` overrides. Its own class rather
 * than a message, the `UnknownApiKey` precedent, so the action can answer it
 * with the cap in the sentence without matching on prose.
 */
export class OverrideLimit extends Error {
  constructor() {
    super(`workspace already has ${OVERRIDE_MAX} pricing overrides`);
    this.name = "OverrideLimit";
  }
}

/** A delete that named an override this workspace does not have. */
export class UnknownOverride extends Error {
  constructor(id: string) {
    super(`no pricing override ${JSON.stringify(id)} in this workspace`);
    this.name = "UnknownOverride";
  }
}

/**
 * The match, as a total parse (D68): it arrives on a server action's FormData,
 * so it may be absent, repeated, empty, five thousand characters or hostile.
 *
 * It is LOWERCASED here, and that is a cross-language contract rather than a
 * nicety: `pricing.Table.WithOverrides` lowercases every match it layers and
 * SKIPS the second row for a prefix already taken (`pricing.go`), so storing
 * `GPT-4o` beside `gpt-4o` would pass the UNIQUE constraint, show two rows in
 * this tab and price with only one of them. Lowercasing at the write makes the
 * database's idea of "the same match" the same as Go's.
 *
 * The alphabet is a POSITIVE one, the `parseInvitationId` shape: what a model
 * name is made of, rather than a list of the hostile characters someone thought
 * of. Anything outside it — a space, a control character, a NUL `pg` cannot
 * even send — could never be a prefix of a model ingest looks up, and a row
 * that can never price anything must not be storable.
 */
const MATCH_ALPHABET = /^[a-z0-9._:/-]+$/;

export function parseOverrideMatch(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const match = value.trim().toLowerCase();
  if (!match || match.length > OVERRIDE_MATCH_MAX) return null;
  if (!MATCH_ALPHABET.test(match)) return null;
  return match;
}

/**
 * A price, as a total parse (D68). `Number("")` is 0 and `Number(" 1 ")` is 1,
 * so the empty string is refused before the conversion rather than banked as a
 * free model. Negative and non-finite are refused because Go skips a negative
 * override row outright — the surface must not accept a value the pricer will
 * silently ignore.
 */
export function parsePricePerMTok(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text) return null;
  const price = Number(text);
  if (!Number.isFinite(price) || price < 0 || price > PRICE_PER_MTOK_MAX) return null;
  return price;
}

/**
 * Every key of the workspace, with its health row if it has one — a LEFT JOIN,
 * because a key that has authenticated but never carried an accepted record has
 * no row and must render as "no events yet" rather than vanish from the list.
 * Revoked keys stay listed for the reason the keys tab lists them: a key that
 * stopped working is a thing an operator needs to see.
 *
 * The workspace is the WHERE clause on `api_keys`, so the join cannot reach a
 * health row of another workspace even though `api_key_health` carries its own
 * `workspace_id`.
 */
const HEALTH_SQL = `
  SELECT k.id          AS key_id,
         k.name        AS name,
         k.prefix      AS prefix,
         k.revoked_at  AS revoked_at,
         coalesce(h.accepted, 0)            AS accepted,
         coalesce(h.dropped_decode, 0)      AS dropped_decode,
         coalesce(h.dropped_unsupported, 0) AS dropped_unsupported,
         coalesce(h.dropped_quota, 0)       AS dropped_quota,
         h.last_event_at AS last_event_at,
         h.updated_at    AS updated_at
    FROM api_keys k
    LEFT JOIN api_key_health h ON h.key_id = k.id
   WHERE k.workspace_id = $1
   ORDER BY k.created_at, k.id`;

/** Ordered by match so the list reads the same on every load. */
const OVERRIDES_SQL = `
  SELECT id, match, input_per_mtok, output_per_mtok, updated_at
    FROM pricing_overrides
   WHERE workspace_id = $1
   ORDER BY match`;

/**
 * Create or edit one override, counting only the OTHER matches so an edit adds
 * nothing to bound and replacing an existing match still works at the cap.
 *
 * The count is a subquery inside the INSERT rather than a SELECT before it, but
 * a single statement is NOT what makes the cap hold under concurrency (B4-1):
 * two overlapping creates each read their `count(*)` under their own READ
 * COMMITTED snapshot, neither sees the other's uncommitted row, both count 99
 * and both write — the "two tabs at ninety-nine" the subquery was meant to
 * close. What closes it is `pg_advisory_xact_lock(hashtext(workspace_id))` taken
 * before this statement inside the caller's transaction (D197): the second
 * create blocks in `lockWorkspace` until the first commits, then runs this count
 * against a snapshot that SEES the committed row and is refused at the cap.
 *
 * The conflict target is the UNIQUE the migration states, which makes editing
 * an override the same call as creating one: one rate pair per match per
 * workspace, and no duplicate for the resolver to break a tie between.
 */
const UPSERT_OVERRIDE_SQL = `
  INSERT INTO pricing_overrides (id, workspace_id, match, input_per_mtok, output_per_mtok, updated_at)
       SELECT $1::text, $2::text, $3::text, $4::double precision, $5::double precision, now()
        WHERE (SELECT count(*) FROM pricing_overrides o
                WHERE o.workspace_id = $2::text AND o.match <> $3::text) < $6::int
  ON CONFLICT (workspace_id, match)
    DO UPDATE SET input_per_mtok = EXCLUDED.input_per_mtok,
                  output_per_mtok = EXCLUDED.output_per_mtok,
                  updated_at = now()
    RETURNING id, match, input_per_mtok, output_per_mtok, updated_at`;

/**
 * Scoped by workspace, so an id from another workspace deletes nothing and
 * returns nothing — the action is reachable by a direct POST (Next's own
 * warning), so the workspace in the WHERE clause is the whole authorization
 * (D148).
 */
const DELETE_OVERRIDE_SQL = `
  DELETE FROM pricing_overrides
        WHERE workspace_id = $1 AND id = $2
    RETURNING id`;

/** `pg` hands back `bigint` as a string; ours are event counts, not big integers. */
const toCount = (raw: string | number): number => Number(raw);

type HealthRow = {
  key_id: string;
  name: string;
  prefix: string;
  revoked_at: Date | null;
  accepted: string;
  dropped_decode: string;
  dropped_unsupported: string;
  dropped_quota: string;
  last_event_at: Date | null;
  updated_at: Date | null;
};

type OverrideRow = {
  id: string;
  match: string;
  input_per_mtok: number;
  output_per_mtok: number;
  updated_at: Date;
};

const toOverride = (row: OverrideRow): PricingOverride => ({
  id: row.id,
  match: row.match,
  inputPerMTok: row.input_per_mtok,
  outputPerMTok: row.output_per_mtok,
  updatedAt: row.updated_at,
});

const newId = (): string => `pov_${randomBytes(8).toString("hex")}`;

/**
 * This workspace's ingest health. The totals are summed HERE, once, off the
 * same rows the per-key list renders — a workspace error count derived from a
 * second query would be a second definition of the same number, and the tab
 * would eventually show a total its own rows do not add up to.
 */
export async function getIngestHealth(
  workspaceId: string,
  query: QueryRows,
): Promise<WorkspaceIngestHealth> {
  const rows = await query<HealthRow>(HEALTH_SQL, [workspaceId]);
  const keys = rows.map((row) => ({
    keyId: row.key_id,
    name: row.name,
    prefix: row.prefix,
    revoked: row.revoked_at !== null,
    accepted: toCount(row.accepted),
    droppedDecode: toCount(row.dropped_decode),
    droppedUnsupported: toCount(row.dropped_unsupported),
    droppedQuota: toCount(row.dropped_quota),
    lastEventAt: row.last_event_at,
    asOf: row.updated_at,
  }));

  let asOf: Date | null = null;
  for (const key of keys) {
    if (key.asOf && (!asOf || key.asOf > asOf)) asOf = key.asOf;
  }

  return {
    keys,
    accepted: keys.reduce((sum, key) => sum + key.accepted, 0),
    receiveErrors: keys.reduce((sum, key) => sum + key.droppedDecode + key.droppedUnsupported, 0),
    droppedQuota: keys.reduce((sum, key) => sum + key.droppedQuota, 0),
    asOf,
  };
}

/** This workspace's overrides, by match. */
export async function listPricingOverrides(
  workspaceId: string,
  query: QueryRows,
): Promise<PricingOverride[]> {
  const rows = await query<OverrideRow>(OVERRIDES_SQL, [workspaceId]);
  return rows.map(toOverride);
}

/**
 * Set this workspace's price for a model prefix. The match and both prices are
 * already parsed by the caller — a blank match or a negative price is an error
 * the surface shows and not a value this function may coerce into shape.
 *
 * The workspace lock is taken FIRST (D197): the cap is a read-modify-write, so
 * the create counts and inserts under one advisory lock and two concurrent
 * creates at the boundary serialize — the loser reads the committed row and is
 * refused. The lock is transaction-scoped and serializes only when `query` is
 * bound to a transaction, which is why `query` is a `TxQuery` (D199): the type
 * demands the transaction the lock needs, so a plain pooled `queryRows` — through
 * which the lock would release inside its own implicit transaction and serialize
 * nothing — does not typecheck here, and the cap can no longer silently re-open
 * on a caller that forgot to wrap. `saveOverride` opens that transaction with
 * `withTransaction`; the injected seam (D113) is unchanged, the lock is just
 * another `$1`-bound statement on it.
 *
 * No rows back means the cap turned the INSERT into a no-op, which is the only
 * way that can happen: a conflicting row updates and returns.
 */
export async function upsertPricingOverride(
  workspaceId: string,
  override: { match: string; inputPerMTok: number; outputPerMTok: number },
  query: TxQuery,
): Promise<PricingOverride> {
  await lockWorkspace(query, workspaceId);
  const [row] = await query<OverrideRow>(UPSERT_OVERRIDE_SQL, [
    newId(),
    workspaceId,
    override.match,
    override.inputPerMTok,
    override.outputPerMTok,
    OVERRIDE_MAX,
  ]);
  if (!row) throw new OverrideLimit();
  return toOverride(row);
}

/** Drop one of THIS workspace's overrides; the model falls back to the embedded list. */
export async function deletePricingOverride(
  workspaceId: string,
  id: string,
  query: QueryRows,
): Promise<void> {
  const [row] = await query<{ id: string }>(DELETE_OVERRIDE_SQL, [workspaceId, id]);
  if (!row) throw new UnknownOverride(id);
}
