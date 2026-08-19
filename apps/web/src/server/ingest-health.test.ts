import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";
import { HOSTILE_URL_VALUES } from "@/lib/hostile-url-values";
import {
  BASE_PRICES_AS_OF,
  BASE_PRICES_COUNT,
  OVERRIDE_MATCH_MAX,
  OVERRIDE_MAX,
  OverrideLimit,
  PRICE_PER_MTOK_MAX,
  UnknownOverride,
  deletePricingOverride,
  getIngestHealth,
  listPricingOverrides,
  parseOverrideMatch,
  parsePricePerMTok,
  upsertPricingOverride,
} from "./ingest-health";
import type { QueryRows } from "./postgres";

// run with: npm test --workspace apps/web
//
// The Data & ingest tab's store, with no Postgres at all: the workspace binding
// on every statement, the D164(f) cap living inside the INSERT rather than in a
// check a second tab could race, and the two total parses the override form
// hands untrusted strings to (D68). Whether the SQL runs is proven by the drive
// against the compose stack (T10) — this file proves what the SQL SAYS.

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

/** A health row as Postgres RETURNs it: bigints as strings, timestamps as Dates. */
const healthRow = (over: Partial<Record<string, unknown>> = {}) => ({
  key_id: "key_0011223344556677",
  name: "collector",
  prefix: "ok_live_9f3a",
  revoked_at: null,
  accepted: "120",
  dropped_decode: "3",
  dropped_unsupported: "1",
  dropped_quota: "40",
  last_event_at: new Date("2026-08-19T10:00:00Z"),
  updated_at: new Date("2026-08-19T10:00:05Z"),
  ...over,
});

const overrideRow = () => ({
  id: "pov_0011223344556677",
  match: "my-ft-classifier",
  input_per_mtok: 0.4,
  output_per_mtok: 1.6,
  updated_at: new Date("2026-08-19T10:00:00Z"),
});

// ---- the store: one workspace, bound, on every statement (D11/D148) ----

test("every statement is bound to the workspace it was handed", async () => {
  const { query, seen } = recordingQuery([overrideRow()]);

  await getIngestHealth("ws_a", query);
  await listPricingOverrides("ws_a", query);
  await upsertPricingOverride("ws_a", { match: "m", inputPerMTok: 1, outputPerMTok: 2 }, query);
  await deletePricingOverride("ws_a", "pov_0011223344556677", query);

  assert.equal(seen.length, 4, "a statement was added without joining this loop");
  for (const { sql, params } of seen) {
    // Both halves, because either alone is passable: SQL that names the column
    // but binds someone else's id, or a binding no predicate reads.
    assert.match(sql, /workspace_id/, `a statement does not scope by workspace: ${sql}`);
    assert.ok(params?.includes("ws_a"), `a statement never bound its workspace: ${sql}`);
  }
  // The health read is a read: the tab must not be able to write a health row.
  assert.match(seen[0].sql, /^\s*SELECT/);
  assert.equal(/INSERT|UPDATE|DELETE/.test(seen[0].sql), false, seen[0].sql);
});

test("the health read is a LEFT JOIN, so a key with no events is listed rather than missing", async () => {
  const silent = healthRow({
    key_id: "key_ffffffffffffffff",
    accepted: "0",
    dropped_decode: "0",
    dropped_unsupported: "0",
    dropped_quota: "0",
    last_event_at: null,
    updated_at: null,
    revoked_at: new Date("2026-08-19T09:00:00Z"),
  });
  const { query, seen } = recordingQuery([healthRow(), silent]);

  const health = await getIngestHealth("ws_a", query);
  assert.match(seen[0].sql, /LEFT JOIN api_key_health/);
  assert.match(seen[0].sql, /FROM api_keys k/);
  assert.match(seen[0].sql, /WHERE k\.workspace_id = \$1/);

  assert.equal(health.keys.length, 2);
  assert.equal(health.keys[1].lastEventAt, null, "never-used keys date nothing (D162)");
  assert.equal(health.keys[1].asOf, null);
  assert.equal(health.keys[1].revoked, true, "a revoked key stays visible, like the keys tab");
});

test("the workspace totals are sums of the rows listed beside them, and errors exclude quota drops", async () => {
  const { query } = recordingQuery([
    healthRow(),
    healthRow({ key_id: "key_2", accepted: "5", dropped_decode: "2", dropped_unsupported: "0", dropped_quota: "7" }),
  ]);
  const health = await getIngestHealth("ws_a", query);

  assert.equal(health.accepted, 125);
  // 3 + 1 + 2 + 0 — the receive-path drops, and NOT the 47 sampled away: a trace
  // dropped over quota is the degradation the plan bought, not a fault in the
  // customer's instrumentation.
  assert.equal(health.receiveErrors, 6);
  assert.equal(health.droppedQuota, 47);
  assert.equal(
    health.receiveErrors + health.droppedQuota,
    health.keys.reduce((n, k) => n + k.droppedDecode + k.droppedUnsupported + k.droppedQuota, 0),
    "a drop is counted in exactly one of the two totals",
  );
});

test("as_of is the freshest health row, and pg's bigint strings become numbers", async () => {
  const fresher = new Date("2026-08-19T10:00:30Z");
  const { query } = recordingQuery([
    healthRow({ updated_at: fresher }),
    healthRow({ key_id: "key_2", updated_at: new Date("2026-08-19T09:59:00Z") }),
  ]);
  const health = await getIngestHealth("ws_a", query);

  assert.deepEqual(health.asOf, fresher);
  assert.equal(typeof health.keys[0].accepted, "number", "a bigint came back as a string (pg)");
  assert.equal(health.keys[0].accepted, 120);
});

test("an empty workspace has nothing to date", async () => {
  const { query } = recordingQuery([]);
  const health = await getIngestHealth("ws_a", query);
  assert.deepEqual(health, { keys: [], accepted: 0, receiveErrors: 0, droppedQuota: 0, asOf: null });
});

// ---- D164(f): the cap is the statement's, not a caller's ----

test("the cap rides inside the INSERT and counts only the OTHER matches", async () => {
  const { query, seen } = recordingQuery([overrideRow()]);
  await upsertPricingOverride(
    "ws_a",
    { match: "my-ft-classifier", inputPerMTok: 0.4, outputPerMTok: 1.6 },
    query,
  );

  const { sql, params } = seen[0];
  // One statement: two — a SELECT count then an INSERT — is two moments, and two
  // tabs at ninety-nine would both read ninety-nine and both write.
  assert.match(sql, /INSERT INTO pricing_overrides/);
  assert.match(sql, /SELECT count\(\*\) FROM pricing_overrides/);
  assert.match(sql, /o\.match <> \$3::text\) < \$6::int/, "the cap counts rows OTHER than this match");
  // Editing an existing match is the same call: the row's identity is
  // (workspace, match), so there is nothing else an operator could mean.
  assert.match(sql, /ON CONFLICT \(workspace_id, match\)/);
  assert.match(sql, /DO UPDATE SET/);
  assert.equal(params?.[5], OVERRIDE_MAX, "the statement enforces the exported cap, not a literal");
  assert.match(String(params?.[0]), /^pov_[0-9a-f]{16}$/, "overrides carry an app-generated id");
});

test("no row back from the capped INSERT is the cap, and it is its own error class", async () => {
  const { query } = recordingQuery([]);
  await assert.rejects(
    upsertPricingOverride("ws_a", { match: "m", inputPerMTok: 1, outputPerMTok: 2 }, query),
    (error: unknown) => {
      assert.ok(error instanceof OverrideLimit);
      assert.equal((error as Error).name, "OverrideLimit");
      assert.match((error as Error).message, new RegExp(String(OVERRIDE_MAX)));
      return true;
    },
  );
});

test("a delete is judged by the workspace in the WHERE clause", async () => {
  const { query, seen } = recordingQuery([{ id: "pov_0011223344556677" }]);
  await deletePricingOverride("ws_a", "pov_0011223344556677", query);
  assert.match(seen[0].sql, /DELETE FROM pricing_overrides/);
  assert.match(seen[0].sql, /WHERE workspace_id = \$1 AND id = \$2/);
  assert.deepEqual(seen[0].params, ["ws_a", "pov_0011223344556677"]);

  // Zero rows is the only answer a foreign or invented id can get — the refusal
  // is the SQL, not a check a caller could skip (D148).
  const { query: empty } = recordingQuery([]);
  await assert.rejects(deletePricingOverride("ws_b", "pov_0011223344556677", empty), (error: unknown) => {
    assert.ok(error instanceof UnknownOverride);
    assert.equal((error as Error).name, "UnknownOverride");
    return true;
  });
});

// ---- D68 (by rule): both override fields are total parses ----

test("D68 totality: no hostile match throws, and nothing outside the alphabet is stored", () => {
  for (const value of HOSTILE_URL_VALUES) {
    const parsed = ((): string | null => {
      try {
        return parseOverrideMatch(value);
      } catch (error) {
        assert.fail(`parseOverrideMatch threw ${String(error)} — a form parse must never throw (D68)`);
      }
    })();
    if (parsed !== null) {
      assert.match(parsed, /^[a-z0-9._:/-]+$/, JSON.stringify(parsed));
      assert.ok(parsed.length <= OVERRIDE_MATCH_MAX, `${parsed.length} characters got through`);
    }
  }

  // A prototype name is a legal match — it is only ever bound as a parameter and
  // compared as a prefix, never used for a property lookup.
  assert.equal(parseOverrideMatch("toString"), "toString".toLowerCase());
  // LOWERCASED at the write, because `pricing.Table.WithOverrides` lowercases
  // what it layers and SKIPS a second row for a prefix already taken: storing
  // `GPT-4o` beside `gpt-4o` would pass the UNIQUE constraint, list two rows and
  // price with one of them.
  assert.equal(parseOverrideMatch("  GPT-4o  "), "gpt-4o");
  assert.equal(parseOverrideMatch("claude-opus-4-5"), "claude-opus-4-5");
  assert.equal(parseOverrideMatch("azure/my_deploy:v2.1"), "azure/my_deploy:v2.1");
  // a repeated field hands over an array; the first member is judged
  assert.equal(parseOverrideMatch([" GPT-4o ", "second"]), "gpt-4o");

  for (const refused of [
    "",
    "   ",
    "gpt 4o",
    "gpt\t4o",
    "drop table pricing_overrides",
    "gpt-4o'; --",
    "modèle",
    "x".repeat(OVERRIDE_MATCH_MAX + 1),
    null,
    undefined,
    7,
    {},
    [],
  ]) {
    assert.equal(parseOverrideMatch(refused), null, `accepted ${JSON.stringify(refused)}`);
  }
});

test("D68 totality: a price is a finite number inside its bounds or nothing at all", () => {
  for (const value of HOSTILE_URL_VALUES) {
    const parsed = ((): number | null => {
      try {
        return parsePricePerMTok(value);
      } catch (error) {
        assert.fail(`parsePricePerMTok threw ${String(error)} — a form parse must never throw (D68)`);
      }
    })();
    if (parsed !== null) {
      assert.ok(Number.isFinite(parsed), `${String(parsed)} is not a number`);
      assert.ok(parsed >= 0 && parsed <= PRICE_PER_MTOK_MAX, String(parsed));
    }
  }

  assert.equal(parsePricePerMTok("0"), 0, "a free model is a real price, not a missing one");
  assert.equal(parsePricePerMTok(" 3.5 "), 3.5);
  assert.equal(parsePricePerMTok(15), 15);
  assert.equal(parsePricePerMTok([".5", "second"]), 0.5);

  for (const refused of [
    "",
    "   ",
    "abc",
    "-1",
    "1e999",
    "NaN",
    // Go SKIPS a negative override row, so a surface that accepted one would
    // store a price that silently prices nothing (`pricing.go`).
    "-0.0001",
    String(PRICE_PER_MTOK_MAX + 1),
    null,
    undefined,
    {},
    [],
  ]) {
    assert.equal(parsePricePerMTok(refused), null, `accepted ${JSON.stringify(refused)}`);
  }
});

// ---- D29: the embedded price list's date is read, never restated ----

test("the base price list's date and size come from the file ingest embeds", () => {
  // Not a fixed date: the assertion is the SHAPE and the source. A copy of the
  // date typed into TypeScript would pass every test in this file and be wrong
  // the first time the price list is refreshed (D29/S2.3 L3).
  assert.match(BASE_PRICES_AS_OF, /^\d{4}-\d{2}-\d{2}$/, "the price file's as_of is a YYYY-MM-DD date");
  assert.ok(BASE_PRICES_COUNT > 20, `the embedded list priced only ${BASE_PRICES_COUNT} models`);
});
