import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";
import type { SloIndicator } from "@/lib/slo-types";
import {
  MAX_SLOS_PER_WORKSPACE,
  SloRefusal,
  createSlo,
  deleteSlo,
  listSlos,
  setSloEnabled,
  updateSlo,
  type SloInput,
} from "./slos";
import type { QueryRows } from "./postgres";

// run with: cd apps/web && npx tsx --conditions react-server --test src/server/slos.test.ts
//
// The SLO store's contract with no Postgres at all (the `alerts.test.ts` D432
// hermetic half): every statement is bound to the workspace it was handed,
// every mutation takes the D197 advisory lock FIRST, a payload D430 refuses
// costs ZERO statements, the measurement columns are the evaluator's and are
// RESET only when the objective changes (D518). Whether the rows are actually
// disjoint across two workspaces is `slos.integration.test.ts`.

type Statement = { sql: string; params?: unknown[] };

function recordingQuery(reply: (sql: string) => unknown[] = () => []) {
  const seen: Statement[] = [];
  const query: QueryRows = async <Row extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    seen.push({ sql, params });
    return reply(sql) as Row[];
  };
  return { query: query as never, seen };
}

const writes = (seen: Statement[]) => seen.filter((s) => /INSERT|UPDATE|DELETE/.test(s.sql));

async function refusal(work: Promise<unknown>, sentence: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof SloRefusal, `not a SloRefusal: ${String(error)}`);
    assert.equal((error as Error).message, sentence);
    return true;
  });
}

// ---- fixtures ----------------------------------------------------------------------------

const INDICATOR: SloIndicator = { kind: "latency", service: "checkout", thresholdMs: 2000 };
const SLO_ID = "slo_00112233445566aa";
const CHANNEL_ID = "chan_00112233445566aa";

const row = (over: Record<string, unknown> = {}) => ({
  id: SLO_ID,
  name: "Chat latency",
  indicator: INDICATOR,
  target: "99.000",
  eval_window: "30d",
  channel_id: CHANNEL_ID,
  channel_name: "#incidents",
  enabled: true,
  status: "breached",
  current_pct: 98.4,
  budget_burned_pct: 160,
  good_count: "984",
  total_count: "1000",
  evaluated_at: new Date("2026-09-02T10:00:00Z"),
  last_transition_at: new Date("2026-09-02T09:55:00Z"),
  ...over,
});

const input = (over: Partial<SloInput> = {}): SloInput => ({
  name: "Chat latency",
  indicator: INDICATOR,
  target: 99,
  window: "30d",
  channelId: CHANNEL_ID,
  ...over,
});

type EngineOpts = {
  slo?: ReturnType<typeof row> | null;
  slos?: ReturnType<typeof row>[];
  channelExists?: boolean;
  sloCount?: number;
  onWrite?: () => never;
};

function engine({ slo = row(), slos = [row()], channelExists = true, sloCount = 0, onWrite }: EngineOpts = {}) {
  return (sql: string): unknown[] => {
    if (sql.includes("pg_advisory_xact_lock")) return [];
    if (sql.includes("SELECT id\n    FROM notification_channels")) return channelExists ? [{ id: CHANNEL_ID }] : [];
    if (sql.includes("count(*)::int AS n")) return [{ n: sloCount }];
    if (sql.includes("FROM slos s") && sql.includes("s.id = $2")) return slo ? [slo] : [];
    if (sql.includes("FROM slos s")) return slos;
    if (onWrite && /INSERT|UPDATE|DELETE/.test(sql)) onWrite();
    return [];
  };
}

const MUTATIONS: [string, (query: never) => Promise<unknown>][] = [
  ["createSlo", (q) => createSlo("ws_a", input(), q)],
  ["updateSlo", (q) => updateSlo("ws_a", SLO_ID, input(), q)],
  ["setSloEnabled", (q) => setSloEnabled("ws_a", SLO_ID, false, q)],
  ["deleteSlo", (q) => deleteSlo("ws_a", SLO_ID, q)],
];

// ---- D7/D11/D113 ------------------------------------------------------------------------------

test("the list read is bound to the workspace it was handed", async () => {
  const { query, seen } = recordingQuery(engine());
  await listSlos("ws_a", query);
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /s\.workspace_id = \$1/);
  assert.deepEqual(seen[0].params, ["ws_a"]);
});

test("every mutation's statements are bound to the workspace it was handed", async () => {
  for (const [name, run] of MUTATIONS) {
    const { query, seen } = recordingQuery(engine());
    await run(query);
    assert.ok(seen.length > 0, `${name} issued no statements`);
    for (const { sql, params } of seen) {
      assert.match(sql, /workspace_id|pg_advisory_xact_lock\(hashtext\(\$1\)\)/, `${name}: unscoped statement: ${sql}`);
      assert.equal(params?.[0], "ws_a", `${name}: a statement bound ${String(params?.[0])} as its workspace`);
    }
  }
});

test("every mutation takes the workspace advisory lock before it does anything else", async () => {
  for (const [name, run] of MUTATIONS) {
    const { query, seen } = recordingQuery(engine());
    await run(query);
    assert.match(seen[0].sql, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/, `${name} did not lock first`);
    assert.deepEqual(seen[0].params, ["ws_a"]);
  }
});

// ---- D430: shape refusals cost no statement ----------------------------------------------

test("every shape refusal is judged before Postgres and costs no statement", async () => {
  const cases: [string, (query: never) => Promise<unknown>, string][] = [
    ["blank name", (q) => createSlo("ws_a", input({ name: " " }), q), "name is required"],
    ["bad kind", (q) => createSlo("ws_a", input({ indicator: { kind: "errors", service: null } }), q), "kind must be one of availability, latency"],
    ["latency without threshold", (q) => createSlo("ws_a", input({ indicator: { kind: "latency", service: null } }), q), "missing key thresholdMs for a latency indicator"],
    ["availability with threshold", (q) => createSlo("ws_a", input({ indicator: { kind: "availability", service: null, thresholdMs: 1 } }), q), "unknown key thresholdMs for an availability indicator"],
    ["target 0", (q) => createSlo("ws_a", input({ target: 0 }), q), "target must be a percentage between 0 and 100, exclusive, with at most three decimals"],
    ["target 100", (q) => createSlo("ws_a", input({ target: 100 }), q), "target must be a percentage between 0 and 100, exclusive, with at most three decimals"],
    ["target NaN", (q) => createSlo("ws_a", input({ target: Number.NaN }), q), "target must be a percentage between 0 and 100, exclusive, with at most three decimals"],
    ["target with four decimals", (q) => createSlo("ws_a", input({ target: 99.9999 }), q), "target must be a percentage between 0 and 100, exclusive, with at most three decimals"],
    ["target as a string", (q) => createSlo("ws_a", input({ target: "99" as never }), q), "target must be a percentage between 0 and 100, exclusive, with at most three decimals"],
    ["window outside the vocabulary", (q) => createSlo("ws_a", input({ window: "1d" as never }), q), "window must be one of 7d, 30d"],
    ["blank channel id", (q) => createSlo("ws_a", input({ channelId: " " }), q), "channel must be a channel id or null"],
    ["non-boolean enabled", (q) => setSloEnabled("ws_a", SLO_ID, "yes" as never, q), "enabled is true or false"],
    ["update with a bad window", (q) => updateSlo("ws_a", SLO_ID, input({ window: "90d" as never }), q), "window must be one of 7d, 30d"],
  ];
  for (const [name, run, sentence] of cases) {
    const { query, seen } = recordingQuery(engine());
    await refusal(run(query), sentence);
    assert.deepEqual(seen, [], `${name} reached the database`);
  }
});

test("targets with up to three decimals are accepted and bound as given", async () => {
  for (const target of [99.9, 99.99, 99.999, 50, 0.001, 99.5]) {
    const { query, seen } = recordingQuery(engine());
    await createSlo("ws_a", input({ target }), query);
    const [insert] = writes(seen);
    assert.equal((insert.params as unknown[])[4], target);
  }
});

// ---- the channel: optional, and must EXIST when named (after the lock) -------------

test("a named channel this workspace does not hold is refused; a null channel is never looked up", async () => {
  for (const run of [
    (q: never) => createSlo("ws_a", input(), q),
    (q: never) => updateSlo("ws_a", SLO_ID, input(), q),
  ]) {
    const { query, seen } = recordingQuery(engine({ channelExists: false }));
    await refusal(run(query), "no notification channel with this id in your workspace");
    assert.deepEqual(writes(seen), [], "an SLO referencing an absent channel was written");
  }

  const { query, seen } = recordingQuery(engine());
  await createSlo("ws_a", input({ channelId: null }), query);
  assert.equal(seen.some((s) => s.sql.includes("FROM notification_channels")), false, "a null channel was looked up");
  const [insert] = writes(seen);
  assert.equal((insert.params as unknown[])[6], null);
});

// ---- D513: the cap ----------------------------------------------------------------------------

test("a workspace at the cap is refused a new SLO, and one below it is not", async () => {
  const at = recordingQuery(engine({ sloCount: MAX_SLOS_PER_WORKSPACE }));
  await refusal(createSlo("ws_a", input(), at.query), `this workspace already has ${MAX_SLOS_PER_WORKSPACE} SLOs — the maximum`);
  assert.deepEqual(writes(at.seen), []);

  const below = recordingQuery(engine({ sloCount: MAX_SLOS_PER_WORKSPACE - 1 }));
  await createSlo("ws_a", input(), below.query);
  assert.equal(writes(below.seen).length, 1);
});

// ---- D440 ------------------------------------------------------------------------------------------

test("an id this workspace does not hold is the D440 sentence, and nothing is written", async () => {
  for (const [name, run] of [
    ["updateSlo", (q: never) => updateSlo("ws_a", "slo_ffffffffffffffff", input(), q)],
    ["setSloEnabled", (q: never) => setSloEnabled("ws_a", "slo_ffffffffffffffff", true, q)],
  ] as const) {
    const { query, seen } = recordingQuery(engine({ slo: null }));
    await refusal(run(query), "no SLO with this id in your workspace");
    assert.deepEqual(writes(seen), [], `${name} wrote against an id this workspace does not hold`);
  }
});

test("deleting an id this workspace does not hold matches nothing and answers with the list", async () => {
  const { query, seen } = recordingQuery(engine({ slos: [row()] }));
  const list = await deleteSlo("ws_a", "slo_ffffffffffffffff", query);
  assert.equal(list.length, 1);
  assert.match(writes(seen)[0].sql, /DELETE FROM slos/);
});

// ---- D424: refuse, never upsert ------------------------------------------------------------

test("creating an SLO under a taken name is refused, never upserted", async () => {
  const duplicate = (): never => {
    throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
  };
  const { query, seen } = recordingQuery(engine({ onWrite: duplicate }));
  await refusal(createSlo("ws_a", input({ name: "Chat latency" }), query), `the name “Chat latency” is already in use`);
  const [insert] = writes(seen);
  assert.match(insert.sql, /INSERT INTO slos/);
  assert.equal(/ON CONFLICT/.test(insert.sql), false);
});

test("a created SLO gets an app-generated id and the indicator is bound as JSON", async () => {
  const { query, seen } = recordingQuery(engine());
  await createSlo("ws_a", input(), query);
  const [insert] = writes(seen);
  const params = insert.params as unknown[];
  assert.match(params[1] as string, /^slo_[0-9a-f]{16}$/);
  assert.deepEqual(JSON.parse(params[3] as string), INDICATOR);
  assert.equal(params[5], "30d");
});

// ---- updateSlo: the editable columns, and the D518 reset --------------------------------

test("updateSlo's UPDATE names the editable columns only — never enabled, status, a measurement or next_eval_at", async () => {
  const { query, seen } = recordingQuery(engine());
  await updateSlo("ws_a", SLO_ID, input({ name: "renamed" }), query);
  const [update] = writes(seen);
  assert.match(update.sql, /UPDATE slos/);
  assert.match(update.sql, /SET name = \$3, indicator = \$4::jsonb, target = \$5, eval_window = \$6, channel_id = \$7, updated_at = now\(\)/);
  for (const banned of [/\benabled\b/, /\bstatus\b/, /current_pct/, /good_count/, /next_eval_at/]) {
    assert.equal(banned.test(update.sql), false, update.sql);
  }
});

test("a rename or a channel change leaves the measurement alone; an objective change resets it (D518)", async () => {
  const rename = recordingQuery(engine());
  await updateSlo("ws_a", SLO_ID, input({ name: "renamed", channelId: null }), rename.query);
  assert.equal(writes(rename.seen).length, 1, "a rename issued a reset");

  for (const [what, change] of [
    ["target", { target: 99.5 }],
    ["window", { window: "7d" as const }],
    ["indicator", { indicator: { kind: "latency", service: "checkout", thresholdMs: 1500 } }],
  ] as const) {
    const { query, seen } = recordingQuery(engine());
    await updateSlo("ws_a", SLO_ID, input(change), query);
    const [, reset] = writes(seen);
    assert.ok(reset, `a ${what} change issued no reset`);
    assert.match(reset.sql, /SET status = 'no-data', current_pct = NULL, budget_burned_pct = NULL,\s+good_count = NULL, total_count = NULL, evaluated_at = NULL, last_transition_at = NULL,\s+next_eval_at = now\(\)/);
    assert.deepEqual(reset.params, ["ws_a", SLO_ID]);
  }

  // The same indicator with its keys in another order is the same objective.
  const reordered = recordingQuery(engine());
  await updateSlo("ws_a", SLO_ID, input({ indicator: { thresholdMs: 2000, service: "checkout", kind: "latency" } }), reordered.query);
  assert.equal(writes(reordered.seen).length, 1, "a key-order change was read as an objective change");
});

// ---- the row mapping ----------------------------------------------------------------------------

test("listSlos maps Postgres strings to numbers and dates to ISO, and null measurements stay null", async () => {
  const measured = recordingQuery(engine({ slos: [row()] }));
  const [m] = await listSlos("ws_a", measured.query);
  assert.equal(m.target, 99);
  assert.equal(m.window, "30d");
  assert.equal(m.goodCount, 984);
  assert.equal(m.totalCount, 1000);
  assert.equal(m.currentPct, 98.4);
  assert.equal(m.evaluatedAt, "2026-09-02T10:00:00.000Z");
  assert.equal(m.lastTransitionAt, "2026-09-02T09:55:00.000Z");
  assert.equal(m.channelName, "#incidents");

  const fresh = recordingQuery(
    engine({
      slos: [row({ status: "no-data", current_pct: null, budget_burned_pct: null, good_count: null, total_count: null, evaluated_at: null, last_transition_at: null, channel_id: null, channel_name: null, target: "99.950" })],
    }),
  );
  const [f] = await listSlos("ws_a", fresh.query);
  assert.equal(f.status, "no-data");
  assert.equal(f.currentPct, null);
  assert.equal(f.goodCount, null);
  assert.equal(f.evaluatedAt, null);
  assert.equal(f.channelId, null);
  assert.equal(f.channelName, null);
  assert.equal(f.target, 99.95);
});
