import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import type { MetricAlertCondition } from "@/lib/alert-types";
import {
  AlertRefusal,
  createAlertRule,
  createNotificationChannel,
  deleteAlertRule,
  deleteNotificationChannel,
  listAlertEvents,
  listAlertEventsInWindow,
  listAlertRules,
  listNotificationChannels,
  sendTestNotification,
  setAlertRuleEnabled,
  setNotificationChannelEnabled,
  updateAlertRule,
  type AlertRuleInput,
  type NewNotificationChannel,
} from "./alerts";
import { getPool, queryRows, withTransaction } from "./postgres";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait postgres ingest
// then:     OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//           npm test --workspace apps/web
//
// The rows-actually-disjoint half of the alerts store (the `dashboards.
// integration.test.ts` D130/D432 pattern): that a rule/channel/event created in
// one workspace is INVISIBLE to another, that no mutation issued for one
// workspace can reach the identically named resources in the other, and that
// the FK RESTRICT between `alert_rules.channel_id` and `notification_channels`
// really refuses a delete inside Postgres, not just in the module's own
// pre-check. `alerts.test.ts` proves the predicates are in the SQL with no
// Postgres at all; this file proves Postgres agrees.
//
// D36 class, and the skip condition is deliberately NARROW: this file
// self-skips only when `OBSTACK_TEST_POSTGRES_DSN` is UNSET — never on a
// refused connection, which fails loudly instead (dashboards.integration.
// test.ts's own reasoning, unchanged here).

const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;

const skip = DSN
  ? undefined
  : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";

if (DSN) process.env.OBSTACK_POSTGRES_DSN = DSN;

function target(): string {
  try {
    const url = new URL(DSN as string);
    return `${url.host}${url.pathname}`;
  } catch {
    return "the configured DSN";
  }
}

after(async () => {
  if (DSN) await getPool().end();
});

/** A refusal is judged by its class AND its exact sentence (D430/D436 idiom). */
async function refusal(work: Promise<unknown>, sentence: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof AlertRefusal, `not an AlertRefusal: ${String(error)}`);
    assert.equal((error as Error).message, sentence);
    return true;
  });
}

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

const ruleInput = (channelId: string, over: Partial<AlertRuleInput> = {}): AlertRuleInput => ({
  name: "High latency",
  condition: CONDITION,
  severity: "warning",
  channelId,
  runbook: null,
  ...over,
});

const channelInput = (target: string, over: Partial<NewNotificationChannel> = {}): NewNotificationChannel => ({
  name: "#incidents",
  kind: "slack_webhook",
  target,
  ...over,
});

/** A fresh pair of workspaces for one test, dropped afterwards (the
 *  `dashboards.integration.test.ts` idiom — a random suffix so a rerun
 *  against the shared compose Postgres never collides with a prior run). */
async function withWorkspacePair(run: (a: string, b: string) => Promise<void>): Promise<void> {
  const tag = randomBytes(6).toString("hex");
  const a = `ws_t5a_${tag}`;
  const b = `ws_t5b_${tag}`;
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2), ($3, $4)`, [
    a,
    `org_t5a_${tag}`,
    b,
    `org_t5b_${tag}`,
  ]);
  try {
    await run(a, b);
  } finally {
    await queryRows(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [a, b]);
  }
}

async function ruleCount(workspaceId: string): Promise<number> {
  const [row] = await queryRows<{ n: string }>(`SELECT count(*)::text AS n FROM alert_rules WHERE workspace_id = $1`, [
    workspaceId,
  ]);
  return Number(row.n);
}

async function channelCount(workspaceId: string): Promise<number> {
  const [row] = await queryRows<{ n: string }>(
    `SELECT count(*)::text AS n FROM notification_channels WHERE workspace_id = $1`,
    [workspaceId],
  );
  return Number(row.n);
}

test("the DSN this run was given answers, and it holds the 0010_alerts migration", { skip }, async () => {
  try {
    assert.equal(await ruleCount(`ws_t5_absent_${randomBytes(4).toString("hex")}`), 0);
  } catch (error) {
    assert.fail(
      `OBSTACK_TEST_POSTGRES_DSN is set but ${target()} did not answer a read of alert_rules — apply ` +
        `services/ingest/pgmigrations in filename order and check the port: ${String(error)}`,
    );
  }
});

// ---- tenancy: rules, channels and events created in one workspace are invisible to the other ----

test("a rule, its channel and a test event created in one workspace are invisible to the other", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const tag = randomBytes(4).toString("hex");
    const target = `https://hooks.example.test/webhooks/${tag}/s3cr3t-A`;

    const aChannel = await withTransaction((q) => createNotificationChannel(a, channelInput(target), q));
    const bChannel = await withTransaction((q) => createNotificationChannel(b, channelInput(target), q));
    const aRule = await withTransaction((q) => createAlertRule(a, ruleInput(aChannel.id), q));
    await withTransaction((q) => createAlertRule(b, ruleInput(bChannel.id), q));
    const aEvent = await withTransaction((q) => sendTestNotification(a, aChannel.id, q));

    assert.deepEqual((await listAlertRules(a, queryRows)).map((r) => r.id), [aRule.id]);
    assert.deepEqual((await listAlertRules(b, queryRows)).map((r) => r.id).includes(aRule.id), false);
    assert.deepEqual((await listNotificationChannels(a, queryRows)).map((c) => c.id), [aChannel.id]);
    assert.deepEqual((await listNotificationChannels(b, queryRows)).map((c) => c.id).includes(aChannel.id), false);
    assert.deepEqual(
      (await listAlertEvents(b, 50, queryRows)).map((e) => e.id).includes(aEvent.id),
      false,
      "workspace b's events feed can see workspace a's test event",
    );

    // The claim is about ROWS, not about what the read path chose to return.
    assert.equal(await ruleCount(a), 1);
    assert.equal(await ruleCount(b), 1);
    assert.equal(await channelCount(a), 1);
    assert.equal(await channelCount(b), 1);
  });
});

test("no mutation issued for one workspace can reach the other's identically named rule or channel", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const tag = randomBytes(4).toString("hex");
    const target = `https://hooks.example.test/webhooks/${tag}/s3cr3t-B`;

    const aChannel = await withTransaction((q) => createNotificationChannel(a, channelInput(target), q));
    const aRule = await withTransaction((q) => createAlertRule(a, ruleInput(aChannel.id), q));
    const bChannel = await withTransaction((q) => createNotificationChannel(b, channelInput(target), q));
    await withTransaction((q) => createAlertRule(b, ruleInput(bChannel.id), q));

    const goneRule = "no alert rule with this id in your workspace";
    const goneChannel = "no notification channel with this id in your workspace";

    // Every mutation, issued for workspace b but naming alice's (workspace a's)
    // rule and channel ids from INSIDE workspace b.
    await refusal(withTransaction((q) => updateAlertRule(b, aRule.id, ruleInput(aChannel.id, { name: "Hijacked" }), q)), goneRule);
    await refusal(withTransaction((q) => setAlertRuleEnabled(b, aRule.id, false, q)), goneRule);
    await refusal(withTransaction((q) => setNotificationChannelEnabled(b, aChannel.id, false, q)), goneChannel);
    await refusal(withTransaction((q) => sendTestNotification(b, aChannel.id, q)), goneChannel);
    await refusal(withTransaction((q) => deleteNotificationChannel(b, aChannel.id, q)), goneChannel);

    // A rule delete does not refuse on an absent id — it matches nothing and
    // answers with b's own list, which is all a foreign id may learn.
    const bsList = await withTransaction((q) => deleteAlertRule(b, aRule.id, q));
    assert.equal(bsList.length, 1, "workspace b's own rule went with a delete aimed at workspace a's");

    // Workspace a's rows survived every attempt untouched.
    assert.equal(await ruleCount(a), 1);
    assert.equal(await channelCount(a), 1);
    assert.deepEqual((await listAlertRules(a, queryRows))[0].name, "High latency");
    assert.equal((await listNotificationChannels(a, queryRows))[0].enabled, true);
  });
});

test("a name is the identity within a workspace, and a taken one is refused rather than upserted", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const tag = randomBytes(4).toString("hex");
    const target = `https://hooks.example.test/webhooks/${tag}/s3cr3t-C`;
    const name = `dup-${tag}`;

    const aChannel = await withTransaction((q) => createNotificationChannel(a, channelInput(target, { name }), q));
    // The identical channel name in the OTHER workspace is a second row, not a refusal.
    await withTransaction((q) => createNotificationChannel(b, channelInput(target, { name }), q));

    await refusal(
      withTransaction((q) => createNotificationChannel(a, channelInput(target, { name }), q)),
      `the name “${name}” is already in use`,
    );

    const ruleName = `dup-rule-${tag}`;
    await withTransaction((q) => createAlertRule(a, ruleInput(aChannel.id, { name: ruleName }), q));
    await refusal(
      withTransaction((q) => createAlertRule(a, ruleInput(aChannel.id, { name: ruleName }), q)),
      `the name “${ruleName}” is already in use`,
    );

    assert.equal(await channelCount(a), 1, "a refused create still wrote a row");
  });
});

// ---- the FK RESTRICT, proven against real Postgres (packet §4) --------------

test("deleting a channel referenced by a rule is refused by Postgres, and succeeds once the rule is gone", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const tag = randomBytes(4).toString("hex");
    const target = `https://hooks.example.test/webhooks/${tag}/s3cr3t-D`;
    const channel = await withTransaction((q) => createNotificationChannel(a, channelInput(target), q));
    const rule = await withTransaction((q) => createAlertRule(a, ruleInput(channel.id), q));

    await refusal(
      withTransaction((q) => deleteNotificationChannel(a, channel.id, q)),
      `“#incidents” is used by 1 alert rule — delete or repoint it first`,
    );
    assert.equal(await channelCount(a), 1, "a refused delete still removed the row");

    await withTransaction((q) => deleteAlertRule(a, rule.id, q));
    const remaining = await withTransaction((q) => deleteNotificationChannel(a, channel.id, q));
    assert.deepEqual(remaining, []);
    assert.equal(await channelCount(a), 0);
  });
});

// ---- D488/D491: the test-notification round trip ----------------------------

test("sendTestNotification round-trips through Postgres as one pending, rule-less event", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const tag = randomBytes(4).toString("hex");
    const target = `https://hooks.example.test/webhooks/${tag}/s3cr3t-E`;
    const channel = await withTransaction((q) =>
      createNotificationChannel(a, channelInput(target, { name: `oncall-${tag}` }), q),
    );

    const before = await listAlertEvents(a, 50, queryRows);
    const event = await withTransaction((q) => sendTestNotification(a, channel.id, q));
    const after = await listAlertEvents(a, 50, queryRows);

    assert.equal(after.length, before.length + 1, "sendTestNotification did not add exactly one event");
    assert.equal(event.ruleId, null);
    assert.equal(event.ruleName, null);
    assert.equal(event.severity, "info");
    assert.equal(event.delivery, "pending");
    assert.match(event.detail, new RegExp(`oncall-${tag}`));
    assert.equal(event.detail.includes(target), false, "the event's detail leaked the channel's target");

    const [row] = await queryRows<{ channel_id: string; rule_id: string | null; attempts: number }>(
      `SELECT channel_id, rule_id, attempts FROM alert_events WHERE id = $1`,
      [event.id],
    );
    assert.equal(row.channel_id, channel.id);
    assert.equal(row.rule_id, null);
    assert.equal(row.attempts, 0);
  });
});

// ---- D487: no read path returns the full target, proven against Postgres ----

test("no read path returns a channel's full target, against real rows", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const tag = randomBytes(4).toString("hex");
    const secretPath = `s3cr3t-recognizable-${tag}`;
    const target = `https://hooks.example.test/webhooks/${tag}/${secretPath}`;
    const channel = await withTransaction((q) => createNotificationChannel(a, channelInput(target), q));
    const rule = await withTransaction((q) => createAlertRule(a, ruleInput(channel.id), q));
    await withTransaction((q) => sendTestNotification(a, channel.id, q));

    const channels = await listNotificationChannels(a, queryRows);
    const rules = await listAlertRules(a, queryRows);
    const events = await listAlertEvents(a, 50, queryRows);
    const everyReadReturned = JSON.stringify({ channels, rules, events });

    assert.equal(everyReadReturned.includes(target), false, "a read path returned the full target");
    assert.equal(everyReadReturned.includes(secretPath), false, "a read path returned the target's secret segment");
    // The row is actually in this list — the assertion above isn't vacuous.
    assert.ok(channels.some((c) => c.id === channel.id));
    assert.ok(rules.some((r) => r.id === rule.id));
  });
});

test("dropping a workspace takes its channels, rules and events with it", { skip }, async () => {
  const tag = randomBytes(6).toString("hex");
  const doomed = `ws_t5c_${tag}`;
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2)`, [doomed, `org_t5c_${tag}`]);
  const target = `https://hooks.example.test/webhooks/${tag}/s3cr3t-F`;
  const channel = await withTransaction((q) => createNotificationChannel(doomed, channelInput(target), q));
  await withTransaction((q) => createAlertRule(doomed, ruleInput(channel.id), q));
  await withTransaction((q) => sendTestNotification(doomed, channel.id, q));
  assert.equal(await ruleCount(doomed), 1);
  assert.equal(await channelCount(doomed), 1);

  await queryRows(`DELETE FROM workspaces WHERE id = $1`, [doomed]);
  assert.equal(await ruleCount(doomed), 0);
  assert.equal(await channelCount(doomed), 0);
});

// ---- S7.4 D534: the half-open window, proven at the boundary by Postgres ----

// The hermetic half (`alerts.test.ts`) can only assert that the statement SAYS
// `>= $2 AND < $3`. Whether Postgres AGREES at the boundary row — whether an
// event stamped at the exact instant the window ends is excluded and one at the
// exact instant it starts is included — is a question only a real database can
// answer, and D534's whole reason (two adjacent incidents must never both claim
// the event at the shared instant) lives on that one row.

const WINDOW_START = "2026-09-04T13:00:00.000Z";
const WINDOW_END = "2026-09-04T13:30:00.000Z";

/** An event straight into Postgres at an EXACT instant: `sendTestNotification`
 *  stamps `created_at` with `now()`, which cannot land on a boundary on
 *  purpose. `rule_id`/`channel_id` are nullable, so this needs neither. */
async function seedEvent(workspaceId: string, id: string, title: string, atIso: string): Promise<void> {
  await queryRows(
    `INSERT INTO alert_events (id, workspace_id, severity, title, detail, created_at)
     VALUES ($1, $2, 'warning', $3, '', $4)`,
    [id, workspaceId, title, atIso],
  );
}

const iso = (base: string, deltaMs: number): string => new Date(Date.parse(base) + deltaMs).toISOString();

test("the alerts leg includes the event AT the window's start and excludes the one AT its end", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const tag = randomBytes(4).toString("hex");
    await seedEvent(a, `evt_${tag}0001`, "one ms before the start", iso(WINDOW_START, -1));
    await seedEvent(a, `evt_${tag}0002`, "exactly at the start", WINDOW_START);
    await seedEvent(a, `evt_${tag}0003`, "inside", iso(WINDOW_START, 15 * 60 * 1000));
    await seedEvent(a, `evt_${tag}0004`, "exactly at the end", WINDOW_END);
    await seedEvent(a, `evt_${tag}0005`, "one ms after the end", iso(WINDOW_END, 1));
    // The other tenant's event at the identical instant (D7/D11): same window,
    // different workspace, and the leg must not see it.
    await seedEvent(b, `evt_${tag}0006`, "the other tenant's", WINDOW_START);

    const inWindow = await listAlertEventsInWindow(a, WINDOW_START, WINDOW_END, 51, queryRows);
    assert.deepEqual(
      inWindow.map((e) => e.title),
      ["exactly at the start", "inside"],
      "the half-open window must take the row at `start` and leave the row at `end` to the next incident",
    );
    assert.deepEqual(inWindow.map((e) => e.at), [WINDOW_START, iso(WINDOW_START, 15 * 60 * 1000)]);

    // Neither exclusion is vacuous: both excluded rows are really there, and it
    // is the BOUND that leaves them out, not a missing seed.
    const nudgedEnd = await listAlertEventsInWindow(a, WINDOW_START, iso(WINDOW_END, 1), 51, queryRows);
    assert.deepEqual(nudgedEnd.map((e) => e.title), ["exactly at the start", "inside", "exactly at the end"]);
    const nudgedStart = await listAlertEventsInWindow(a, iso(WINDOW_START, -1), WINDOW_END, 51, queryRows);
    assert.deepEqual(nudgedStart.map((e) => e.title), ["one ms before the start", "exactly at the start", "inside"]);
    const nudgedForward = await listAlertEventsInWindow(a, iso(WINDOW_START, 1), WINDOW_END, 51, queryRows);
    assert.deepEqual(nudgedForward.map((e) => e.title), ["inside"], "`>=` must be an inclusive lower bound and nothing wider");

    assert.deepEqual(
      (await listAlertEventsInWindow(b, WINDOW_START, WINDOW_END, 51, queryRows)).map((e) => e.title),
      ["the other tenant's"],
      "the window read leaked across workspaces",
    );
  });
});

test("the alerts leg reads FORWARD, breaks ties on id, and its limit keeps the OLDEST rows", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const tag = randomBytes(4).toString("hex");
    const tie = iso(WINDOW_START, 10 * 60 * 1000);
    await seedEvent(a, `evt_${tag}0003`, "third", iso(WINDOW_START, 20 * 60 * 1000));
    await seedEvent(a, `evt_${tag}0002`, "second", tie);
    await seedEvent(a, `evt_${tag}0001`, "first", iso(WINDOW_START, 5 * 60 * 1000));
    // Same instant as "second", a LOWER id: the tie-break, not insertion order.
    await seedEvent(a, `evt_${tag}0000`, "second's tie", tie);

    const rows = await listAlertEventsInWindow(a, WINDOW_START, WINDOW_END, 51, queryRows);
    assert.deepEqual(rows.map((e) => e.title), ["first", "second's tie", "second", "third"]);

    // A timeline leg is read `LIMIT cap + 1` and the probe row is the LAST one,
    // so the cap must keep the EARLIEST rows — the opposite of the feed's.
    assert.deepEqual(
      (await listAlertEventsInWindow(a, WINDOW_START, WINDOW_END, 2, queryRows)).map((e) => e.title),
      ["first", "second's tie"],
    );
    // The same four rows through the FEED keep the newest two. Compared by
    // INSTANT, not by title, and deliberately: the shipped feed statement is
    // `ORDER BY e.created_at DESC` with NO tie-break, so which of the two rows
    // at `tie` it returns is the planner's to choose (observed both ways on
    // this Postgres). That is the defect the timeline leg's `, e.id` closes,
    // and asserting a title here would have pinned the coin flip.
    assert.deepEqual(
      (await listAlertEvents(a, 2, queryRows)).map((e) => e.at),
      [iso(WINDOW_START, 20 * 60 * 1000), tie],
    );
  });
});
