import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { QueryResultRow } from "pg";
import type { MetricAlertCondition } from "@/lib/alert-types";
import {
  AlertRefusal,
  MAX_ALERT_RULES_PER_WORKSPACE,
  createAlertRule,
  createNotificationChannel,
  deleteAlertRule,
  deleteNotificationChannel,
  listAlertEvents,
  listAlertRules,
  listNotificationChannels,
  maskTarget,
  sendTestNotification,
  setAlertRuleEnabled,
  setNotificationChannelEnabled,
  updateAlertRule,
  type AlertRuleInput,
  type NewNotificationChannel,
} from "./alerts";
import type { QueryRows } from "./postgres";

// run with: cd apps/web && npx tsx --conditions react-server --test src/server/alerts.test.ts
//
// The alerts store's contract with no Postgres at all (the `dashboards.test.ts`
// D432 hermetic half): every statement is bound to the workspace it was
// handed, every mutation takes the D197 advisory lock FIRST, a payload D430
// refuses costs ZERO statements, a channel target is NEVER the full string on
// any read path, and a channel referenced by a rule cannot be deleted.
// Whether the rows are actually disjoint across two workspaces is
// `alerts.integration.test.ts`; this file proves what the statements SAY and
// in what ORDER, with no Postgres present.

type Statement = { sql: string; params?: unknown[] };

/** The `dashboards.test.ts` recorder, unmodified: answers by statement SHAPE
 *  because a mutation here is lock → (exists check) → write → read back, and
 *  handing every call the same rows would prove nothing about any of them. */
function recordingQuery(reply: (sql: string) => unknown[] = () => []) {
  const seen: Statement[] = [];
  const query: QueryRows = async <Row extends QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> => {
    seen.push({ sql, params });
    return reply(sql) as Row[];
  };
  return { query: query as never, seen };
}

const writes = (seen: Statement[]) => seen.filter((s) => /INSERT|UPDATE|DELETE/.test(s.sql));

/** A refusal is judged by its class AND its exact sentence (D430/D436 idiom). */
async function refusal(work: Promise<unknown>, sentence: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof AlertRefusal, `not an AlertRefusal: ${String(error)}`);
    assert.equal((error as Error).message, sentence);
    return true;
  });
}

// ---- fixtures -----------------------------------------------------------------

const CONDITION: MetricAlertCondition = {
  source: "metric",
  metric: "http.server.duration",
  type: "histogram",
  agg: "p95",
  window: "5m",
  op: ">",
  threshold: 800,
  filters: {},
};

const RULE_ID = "rule_00112233445566aa";
const CHANNEL_ID = "chan_00112233445566aa";
const SECRET_TARGET = "https://hooks.slack.com/services/T000/B000/s3cr3tTOKEN1234";

const ruleRow = (over: Record<string, unknown> = {}) => ({
  id: RULE_ID,
  name: "High latency",
  condition: CONDITION,
  severity: "warning",
  channel_id: CHANNEL_ID,
  channel_name: "#incidents",
  enabled: true,
  runbook: null,
  state: "ok",
  last_triggered_at: null,
  ...over,
});

const channelRow = (over: Record<string, unknown> = {}) => ({
  id: CHANNEL_ID,
  name: "#incidents",
  kind: "slack_webhook",
  target: SECRET_TARGET,
  enabled: true,
  ...over,
});

const eventRow = (over: Record<string, unknown> = {}) => ({
  id: "evt_00112233445566aa",
  rule_id: null,
  rule_name: null,
  slo_id: null,
  slo_name: null,
  severity: "info",
  title: "Test notification",
  detail: `Manual test notification for channel “#incidents”.`,
  link: null,
  delivery: "pending",
  created_at: new Date("2026-09-02T10:00:00Z"),
  ...over,
});

const ruleInput = (over: Partial<AlertRuleInput> = {}): AlertRuleInput => ({
  name: "High latency",
  condition: CONDITION,
  severity: "warning",
  channelId: CHANNEL_ID,
  runbook: null,
  ...over,
});

const channelInput = (over: Partial<NewNotificationChannel> = {}): NewNotificationChannel => ({
  name: "#incidents",
  kind: "slack_webhook",
  target: SECRET_TARGET,
  ...over,
});

type EngineOpts = {
  rule?: ReturnType<typeof ruleRow> | null;
  rules?: ReturnType<typeof ruleRow>[];
  channel?: ReturnType<typeof channelRow> | null;
  channels?: ReturnType<typeof channelRow>[];
  channelExists?: boolean;
  referencing?: number;
  referencingSlos?: number;
  ruleCount?: number;
  event?: ReturnType<typeof eventRow> | null;
  onWrite?: () => never;
};

/** The engine, as far as this file is concerned: which statement gets which
 *  rows (the `dashboards.test.ts` idiom). Branch order matters: the narrower
 *  `id = $2` shapes are checked before the list shapes they'd otherwise also
 *  match. */
function engine({
  rule = ruleRow(),
  rules = [ruleRow()],
  channel = channelRow(),
  channels = [channelRow()],
  channelExists = true,
  referencing = 0,
  referencingSlos = 0,
  ruleCount = 0,
  event = eventRow(),
  onWrite,
}: EngineOpts = {}) {
  return (sql: string): unknown[] => {
    if (sql.includes("pg_advisory_xact_lock")) return [];
    if (sql.includes("SELECT id\n    FROM notification_channels")) {
      return channelExists ? [{ id: CHANNEL_ID }] : [];
    }
    if (sql.includes("count(*)::int AS n") && sql.includes("channel_id = $2")) {
      return [{ n: sql.includes("FROM slos") ? referencingSlos : referencing }];
    }
    if (sql.includes("count(*)::int AS n")) {
      return [{ n: ruleCount }];
    }
    if (sql.includes("SELECT id, name, kind, target, enabled") && sql.includes("id = $2")) {
      return channel ? [channel] : [];
    }
    if (sql.includes("SELECT id, name, kind, target, enabled")) {
      return channels;
    }
    if (sql.includes("FROM alert_rules r") && sql.includes("r.id = $2")) {
      return rule ? [rule] : [];
    }
    if (sql.includes("FROM alert_rules r")) {
      return rules;
    }
    if (sql.includes("FROM alert_events e") && sql.includes("e.id = $2")) {
      return event ? [event] : [];
    }
    if (sql.includes("FROM alert_events e")) {
      return event ? [event] : [];
    }
    if (onWrite && /INSERT|UPDATE|DELETE/.test(sql)) onWrite();
    return [];
  };
}

// ---- D7/D11/D113: every statement is bound to the workspace it was handed ----

// S7.3 (packet §0): ONE feed — the events read joins the SLO's name beside the rule's.
test("the events feed joins both producers and maps sloId/sloName on every row", async () => {
  const { query, seen } = recordingQuery(engine({ event: eventRow({ rule_id: null, rule_name: null, slo_id: "slo_00112233445566aa", slo_name: "API availability" }) }));
  const [row] = await listAlertEvents("ws_a", 50, query);
  assert.match(seen[0].sql, /LEFT JOIN alert_rules r ON r.id = e.rule_id/);
  assert.match(seen[0].sql, /LEFT JOIN slos s ON s.id = e.slo_id/);
  assert.equal(row.sloId, "slo_00112233445566aa");
  assert.equal(row.sloName, "API availability");
  assert.equal(row.ruleId, null);
});

test("every read statement is bound to the workspace it was handed", async () => {
  const { query, seen } = recordingQuery(engine());

  await listAlertRules("ws_a", query);
  await listAlertEvents("ws_a", 50, query);
  await listNotificationChannels("ws_a", query);

  assert.ok(seen.length >= 3);
  for (const { sql, params } of seen) {
    assert.match(sql, /workspace_id/, `a read does not scope by workspace: ${sql}`);
    assert.equal(params?.[0], "ws_a", `a read bound ${String(params?.[0])} as its workspace`);
  }
});

test("every mutation's statements are bound to the workspace it was handed", async () => {
  const mutations: [string, (query: never) => Promise<unknown>][] = [
    ["createAlertRule", (q) => createAlertRule("ws_a", ruleInput(), q)],
    ["updateAlertRule", (q) => updateAlertRule("ws_a", RULE_ID, ruleInput(), q)],
    ["setAlertRuleEnabled", (q) => setAlertRuleEnabled("ws_a", RULE_ID, false, q)],
    ["deleteAlertRule", (q) => deleteAlertRule("ws_a", RULE_ID, q)],
    ["createNotificationChannel", (q) => createNotificationChannel("ws_a", channelInput(), q)],
    ["setNotificationChannelEnabled", (q) => setNotificationChannelEnabled("ws_a", CHANNEL_ID, false, q)],
    ["deleteNotificationChannel", (q) => deleteNotificationChannel("ws_a", CHANNEL_ID, q)],
    ["sendTestNotification", (q) => sendTestNotification("ws_a", CHANNEL_ID, q)],
  ];

  for (const [name, run] of mutations) {
    const { query, seen } = recordingQuery(engine({ referencing: 0 }));
    await run(query);
    assert.ok(seen.length > 0, `${name} issued no statements`);
    for (const { sql, params } of seen) {
      assert.match(
        sql,
        /workspace_id|pg_advisory_xact_lock\(hashtext\(\$1\)\)/,
        `${name}: a statement does not scope by workspace: ${sql}`,
      );
      assert.equal(params?.[0], "ws_a", `${name}: a statement bound ${String(params?.[0])} as its workspace`);
    }
  }
});

// ---- D429: the lock is the first statement of every mutation ----------------

test("every mutation takes the workspace advisory lock before it does anything else", async () => {
  const mutations: [string, (query: never) => Promise<unknown>][] = [
    ["createAlertRule", (q) => createAlertRule("ws_a", ruleInput(), q)],
    ["updateAlertRule", (q) => updateAlertRule("ws_a", RULE_ID, ruleInput(), q)],
    ["setAlertRuleEnabled", (q) => setAlertRuleEnabled("ws_a", RULE_ID, false, q)],
    ["deleteAlertRule", (q) => deleteAlertRule("ws_a", RULE_ID, q)],
    ["createNotificationChannel", (q) => createNotificationChannel("ws_a", channelInput(), q)],
    ["setNotificationChannelEnabled", (q) => setNotificationChannelEnabled("ws_a", CHANNEL_ID, false, q)],
    ["deleteNotificationChannel", (q) => deleteNotificationChannel("ws_a", CHANNEL_ID, q)],
    ["sendTestNotification", (q) => sendTestNotification("ws_a", CHANNEL_ID, q)],
  ];

  for (const [name, run] of mutations) {
    const { query, seen } = recordingQuery(engine());
    await run(query);
    assert.match(seen[0].sql, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/, `${name} did not lock first`);
    assert.deepEqual(seen[0].params, ["ws_a"], `${name} locked the wrong workspace`);
  }
});

// ---- D430: a shape refusal is judged before Postgres and costs no statement ---

test("every shape refusal is judged before Postgres and costs no statement", async () => {
  const cases: [string, (query: never) => Promise<unknown>, string][] = [
    ["blank rule name", (q) => createAlertRule("ws_a", ruleInput({ name: " " }), q), "name is required"],
    [
      "unknown condition source",
      (q) => createAlertRule("ws_a", ruleInput({ condition: { source: "bogus" } }), q),
      `source must be "metric" or "trace"`,
    ],
    [
      "condition window outside vocabulary",
      (q) => createAlertRule("ws_a", ruleInput({ condition: { ...CONDITION, window: "2h" } }), q),
      "window must be one of 5m, 15m, 30m, 1h",
    ],
    [
      "bad severity",
      (q) => createAlertRule("ws_a", ruleInput({ severity: "urgent" as never }), q),
      "severity must be one of critical, warning, info",
    ],
    ["blank channel id", (q) => createAlertRule("ws_a", ruleInput({ channelId: " " }), q), "a channel is required"],
    ["blank channel name", (q) => createNotificationChannel("ws_a", channelInput({ name: "" }), q), "name is required"],
    [
      "unknown channel kind",
      (q) => createNotificationChannel("ws_a", channelInput({ kind: "email" as never }), q),
      "kind must be one of webhook, slack_webhook",
    ],
    ["blank target", (q) => createNotificationChannel("ws_a", channelInput({ target: " " }), q), "target is required"],
    [
      "unparseable target",
      (q) => createNotificationChannel("ws_a", channelInput({ target: "not a url" }), q),
      "target must be a valid URL",
    ],
    [
      "a target with no host",
      (q) => createNotificationChannel("ws_a", channelInput({ target: "mailto:oncall@example.com" }), q),
      "target must be a valid URL",
    ],
    [
      "a non-boolean enabled flag",
      (q) => setAlertRuleEnabled("ws_a", RULE_ID, "yes" as never, q),
      "enabled is true or false",
    ],
  ];

  for (const [name, run, sentence] of cases) {
    const { query, seen } = recordingQuery(engine());
    await refusal(run(query), sentence);
    assert.deepEqual(seen, [], `${name} reached the database`);
  }
});

// ---- the referenced channel must EXIST (checked after the lock) -------------

test("creating or updating a rule against a channel this workspace does not hold is refused", async () => {
  for (const run of [
    (q: never) => createAlertRule("ws_a", ruleInput(), q),
    (q: never) => updateAlertRule("ws_a", RULE_ID, ruleInput(), q),
  ]) {
    const { query, seen } = recordingQuery(engine({ channelExists: false }));
    await refusal(run(query), "no notification channel with this id in your workspace");
    assert.deepEqual(writes(seen), [], "a rule referencing an absent channel was written");
  }
});

// ---- D489: the rule-count cap ------------------------------------------------

test("a workspace at the D489 rule cap is refused a new rule, and one below it is not", async () => {
  const at = recordingQuery(engine({ ruleCount: MAX_ALERT_RULES_PER_WORKSPACE }));
  await refusal(
    createAlertRule("ws_a", ruleInput(), at.query),
    `this workspace already has ${MAX_ALERT_RULES_PER_WORKSPACE} alert rules — the maximum`,
  );
  assert.deepEqual(writes(at.seen), [], "a rule was written past the cap");

  const below = recordingQuery(engine({ ruleCount: MAX_ALERT_RULES_PER_WORKSPACE - 1 }));
  await createAlertRule("ws_a", ruleInput(), below.query);
  assert.equal(writes(below.seen).length, 1, "one rule INSERT below the cap");
});

// ---- D440: an id this workspace does not hold reads exactly as absent -------

test("a rule id this workspace does not hold is the D440 sentence, and nothing is written", async () => {
  for (const [name, run] of [
    ["updateAlertRule", (q: never) => updateAlertRule("ws_a", "rule_ffffffffffffffff", ruleInput(), q)],
    ["setAlertRuleEnabled", (q: never) => setAlertRuleEnabled("ws_a", "rule_ffffffffffffffff", true, q)],
  ] as const) {
    const { query, seen } = recordingQuery(engine({ rule: null }));
    await refusal(run(query), "no alert rule with this id in your workspace");
    assert.deepEqual(writes(seen), [], `${name} wrote against an id this workspace does not hold`);
  }
});

test("a channel id this workspace does not hold is the D440 sentence, and nothing is written", async () => {
  for (const [name, run] of [
    ["setNotificationChannelEnabled", (q: never) => setNotificationChannelEnabled("ws_a", "chan_ffffffffffffffff", true, q)],
    ["deleteNotificationChannel", (q: never) => deleteNotificationChannel("ws_a", "chan_ffffffffffffffff", q)],
    ["sendTestNotification", (q: never) => sendTestNotification("ws_a", "chan_ffffffffffffffff", q)],
  ] as const) {
    const { query, seen } = recordingQuery(engine({ channel: null }));
    await refusal(run(query), "no notification channel with this id in your workspace");
    assert.deepEqual(writes(seen), [], `${name} wrote against an id this workspace does not hold`);
  }
});

// ---- deleteAlertRule/deleteNotificationChannel never refuse an absent id ----

test("deleting a rule id this workspace does not hold matches nothing and answers with the list", async () => {
  const { query, seen } = recordingQuery(engine({ rules: [ruleRow()] }));
  const list = await deleteAlertRule("ws_a", "rule_ffffffffffffffff", query);
  assert.equal(list.length, 1);
  assert.match(writes(seen)[0].sql, /DELETE FROM alert_rules/);
});

// ---- D424: the name is the identity, and a taken one is refused -------------

test("creating a rule under a taken name is refused, never upserted", async () => {
  const duplicate = (): never => {
    throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
  };
  const { query, seen } = recordingQuery(engine({ onWrite: duplicate }));
  await refusal(createAlertRule("ws_a", ruleInput({ name: "High latency" }), query), `the name “High latency” is already in use`);
  const [insert] = writes(seen);
  assert.match(insert.sql, /INSERT INTO alert_rules/);
  assert.equal(/ON CONFLICT/.test(insert.sql), false);
});

test("creating a channel under a taken name is refused, never upserted", async () => {
  const duplicate = (): never => {
    throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
  };
  const { query, seen } = recordingQuery(engine({ onWrite: duplicate }));
  await refusal(
    createNotificationChannel("ws_a", channelInput({ name: "#incidents" }), query),
    `the name “#incidents” is already in use`,
  );
  const [insert] = writes(seen);
  assert.match(insert.sql, /INSERT INTO notification_channels/);
});

// ---- app-generated ids (D437/D116) -------------------------------------------

test("a created rule and a created channel each get an app-generated id", async () => {
  const { query: rq, seen: rseen } = recordingQuery(engine());
  await createAlertRule("ws_a", ruleInput(), rq);
  const [ruleInsert] = writes(rseen);
  assert.match((ruleInsert.params as string[])[1], /^rule_[0-9a-f]{16}$/);

  const { query: cq, seen: cseen } = recordingQuery(engine());
  await createNotificationChannel("ws_a", channelInput(), cq);
  const [channelInsert] = writes(cseen);
  assert.match((channelInsert.params as string[])[1], /^chan_[0-9a-f]{16}$/);
});

// ---- updateAlertRule never touches enabled/state --------------------------

test("updateAlertRule's UPDATE never names enabled, state or next_eval_at", async () => {
  const { query, seen } = recordingQuery(engine());
  await updateAlertRule("ws_a", RULE_ID, ruleInput({ name: "renamed" }), query);
  const [update] = writes(seen);
  assert.match(update.sql, /UPDATE alert_rules/);
  assert.match(update.sql, /SET name = \$3, condition = \$4::jsonb, severity = \$5, channel_id = \$6, runbook = \$7/);
  assert.equal(/\benabled\b/.test(update.sql), false, update.sql);
  assert.equal(/\bstate\b/.test(update.sql), false, update.sql);
  assert.equal(/next_eval_at/.test(update.sql), false, update.sql);
});

// ---- the FK RESTRICT surfaced as a typed refusal (packet §4) ----------------

test("deleting a channel referenced by a rule is refused, and deletable once the rule is gone", async () => {
  const referenced = recordingQuery(engine({ referencing: 2 }));
  await refusal(
    deleteNotificationChannel("ws_a", CHANNEL_ID, referenced.query),
    `“#incidents” is used by 2 alert rules — delete or repoint them first`,
  );
  assert.deepEqual(writes(referenced.seen), [], "a referenced channel was deleted");

  const free = recordingQuery(engine({ referencing: 0, channels: [] }));
  const list = await deleteNotificationChannel("ws_a", CHANNEL_ID, free.query);
  assert.deepEqual(list, []);
  assert.match(writes(free.seen)[0].sql, /DELETE FROM notification_channels/);
});

test("the referencing-rule count is scoped to this workspace and this channel", async () => {
  const { query, seen } = recordingQuery(engine({ referencing: 1 }));
  await refusal(deleteNotificationChannel("ws_a", CHANNEL_ID, query), `“#incidents” is used by 1 alert rule — delete or repoint it first`);
  const counts = seen.filter((s) => s.sql.includes("channel_id = $2"));
  assert.equal(counts.length, 2, "both the rule count and the SLO count are taken");
  for (const count of counts) assert.deepEqual(count.params, ["ws_a", CHANNEL_ID]);
  assert.ok(counts.some((s) => s.sql.includes("FROM alert_rules")));
  assert.ok(counts.some((s) => s.sql.includes("FROM slos")));
});

// S7.3 (D513): an SLO's channel reference is under the same RESTRICT and the
// same check-first — the sentence names what holds the channel.
test("deleting a channel referenced by an SLO is refused too, and the sentence names both kinds when both hold it", async () => {
  const slo = recordingQuery(engine({ referencing: 0, referencingSlos: 1 }));
  await refusal(deleteNotificationChannel("ws_a", CHANNEL_ID, slo.query), `“#incidents” is used by 1 SLO — delete or repoint it first`);
  assert.deepEqual(writes(slo.seen), [], "a channel referenced by an SLO was deleted");

  const both = recordingQuery(engine({ referencing: 2, referencingSlos: 3 }));
  await refusal(
    deleteNotificationChannel("ws_a", CHANNEL_ID, both.query),
    `“#incidents” is used by 2 alert rules and 3 SLOs — delete or repoint them first`,
  );
  assert.deepEqual(writes(both.seen), []);
});

test("a 23503 foreign key violation at DELETE time is also refused, not a 500 (the check-first's backstop)", async () => {
  const fkViolation = (): never => {
    throw Object.assign(new Error("update or delete on table violates foreign key constraint"), { code: "23503" });
  };
  const { query, seen } = recordingQuery(engine({ referencing: 0, onWrite: fkViolation }));
  await refusal(
    deleteNotificationChannel("ws_a", CHANNEL_ID, query),
    `“#incidents” is used by an alert rule or an SLO — delete or repoint it first`,
  );
  assert.match(seen[seen.length - 1].sql, /DELETE FROM notification_channels/);
});

// ---- D488/D491: sendTestNotification -----------------------------------------

test("sendTestNotification inserts exactly one pending, rule-less event naming the channel by NAME", async () => {
  const { query, seen } = recordingQuery(engine());
  const result = await sendTestNotification("ws_a", CHANNEL_ID, query);

  const inserts = writes(seen).filter((s) => s.sql.includes("INSERT INTO alert_events"));
  assert.equal(inserts.length, 1, "sendTestNotification wrote something other than exactly one event");
  const [, id, channelIdParam, detail] = inserts[0].params as string[];
  assert.match(id, /^evt_[0-9a-f]{16}$/);
  assert.equal(channelIdParam, CHANNEL_ID);
  assert.match(inserts[0].sql, /rule_id, channel_id, severity, title, detail, delivery/);
  assert.match(inserts[0].sql, /'info', 'Test notification', \$4, 'pending'/);
  assert.match(inserts[0].sql, /VALUES \(\$1, \$2, NULL, \$3/);

  // The channel's NAME, never its target/secret (D487/D491).
  assert.match(detail, /#incidents/);
  assert.equal(detail.includes(SECRET_TARGET), false, "the test-notification detail leaked the channel's target");
  assert.equal(detail.includes("hooks.slack.com"), false, "the test-notification detail leaked the channel's host");

  assert.equal(result.ruleId, null);
  assert.equal(result.ruleName, null);
  assert.equal(result.sloId, null);
  assert.equal(result.sloName, null);
  assert.equal(result.severity, "info");
  assert.equal(result.delivery, "pending");
});

// ---- D487: masking ------------------------------------------------------------

test("maskTarget matches the Go twin's rule byte for byte (services/ingest/internal/notify/policy.go)", () => {
  assert.equal(
    maskTarget("https://hooks.slack.com/services/T000/B000/s3cr3tTOKEN1234"),
    "https://hooks.slack.com/...1234",
  );
  // The query string is DROPPED entirely — it routinely carries the token.
  assert.equal(
    maskTarget("https://hooks.slack.com/services/T000/B000/s3cr3tTOKEN1234?x=extra-secret"),
    "https://hooks.slack.com/...1234",
  );
  // Userinfo is DROPPED entirely.
  assert.equal(maskTarget("https://user:pass@example.com/hook/abcd"), "https://example.com/...abcd");
  // Port is preserved as part of `host`; a path of 4 chars or fewer is kept whole.
  assert.equal(maskTarget("https://example.com:8443/xyz"), "https://example.com:8443/...xyz");
  // An empty path masks to an empty tail.
  assert.equal(maskTarget("https://example.com"), "https://example.com/...");
  // Unparseable, or missing a host, renders the literal fallback string.
  assert.equal(maskTarget("not a url"), "(invalid target)");
  assert.equal(maskTarget("mailto:oncall@example.com"), "(invalid target)");
});

test("maskTarget never renders the unicode ellipsis — the drive's hygiene sweep diffs byte for byte", () => {
  const out = maskTarget(SECRET_TARGET);
  assert.equal(out.includes("…"), false, "maskTarget used the unicode ellipsis instead of ASCII dots");
  assert.equal(out.includes("..."), true);
});

test("listNotificationChannels never returns the full target on any row", async () => {
  const { query } = recordingQuery(engine({ channels: [channelRow()] }));
  const rows = await listNotificationChannels("ws_a", query);

  assert.equal(rows.length, 1);
  assert.equal("target" in rows[0], false, "the row shape itself carries a `target` key");
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes(SECRET_TARGET), false, "the full target reached a read path's return value");
  assert.equal(serialized.includes("s3cr3tTOKEN"), false, "the secret portion of the target leaked");
  assert.equal(rows[0].targetMasked, "https://hooks.slack.com/...1234");
});

test("createNotificationChannel's and setNotificationChannelEnabled's return values also mask the target", async () => {
  const { query: cq } = recordingQuery(engine());
  const created = await createNotificationChannel("ws_a", channelInput(), cq);
  assert.equal(JSON.stringify(created).includes(SECRET_TARGET), false);
  assert.equal(created.targetMasked, "https://hooks.slack.com/...1234");

  const { query: eq } = recordingQuery(engine());
  const toggled = await setNotificationChannelEnabled("ws_a", CHANNEL_ID, false, eq);
  assert.equal(JSON.stringify(toggled).includes(SECRET_TARGET), false);
});

// ---- D441: the action surface is mutations, and nothing but mutations -------

// Source text, not an import (the `dashboards.test.ts` idiom): `actions.ts` is
// a `"use server"` module and importing it here would pull `server/session.ts`
// and `next/headers` into a runner that has no request.
const ACTIONS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../components/alerts/actions.ts"),
  "utf8",
);

test("the alerts action surface exposes exactly the eight mutations and no read (D441)", () => {
  const exported = [...ACTIONS.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(exported, [
    "createAlertRule",
    "updateAlertRule",
    "setAlertRuleEnabled",
    "deleteAlertRule",
    "createNotificationChannel",
    "setNotificationChannelEnabled",
    "deleteNotificationChannel",
    "sendTestNotification",
  ]);

  for (const banned of ["store.listAlertRules", "store.listAlertEvents", "store.listNotificationChannels", "queryRows"]) {
    assert.equal(ACTIONS.includes(banned), false, `actions.ts reaches for ${banned} — reads belong to the page (D441)`);
  }
});
