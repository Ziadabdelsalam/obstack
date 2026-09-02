import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { createNotificationChannel, deleteNotificationChannel, listAlertEvents, AlertRefusal } from "./alerts";
import { getPool, queryRows, withTransaction } from "./postgres";
import { SloRefusal, createSlo, deleteSlo, listSlos, setSloEnabled, updateSlo, type SloInput } from "./slos";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait postgres ingest
// then:     OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//           npm test --workspace apps/web
//
// The rows-actually-disjoint half of the SLO store (the `alerts.integration.
// test.ts` pattern): an SLO created in one workspace is INVISIBLE to another,
// no mutation issued for one workspace can reach the other's SLO, the channel
// RESTRICT really refuses inside Postgres, the NUMERIC/BIGINT columns come
// back as numbers, the D518 reset really lands, and the events feed's new
// join names an SLO's event. Self-skips only when the DSN is UNSET.

const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;
const skip = DSN ? undefined : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";
if (DSN) process.env.OBSTACK_POSTGRES_DSN = DSN;

after(async () => {
  if (DSN) await getPool().end();
});

async function refusal(work: Promise<unknown>, sentence: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof SloRefusal || error instanceof AlertRefusal, `not a refusal: ${String(error)}`);
    assert.equal((error as Error).message, sentence);
    return true;
  });
}

const input = (over: Partial<SloInput> = {}): SloInput => ({
  name: "API availability",
  indicator: { kind: "availability", service: null },
  target: 99.9,
  window: "30d",
  channelId: null,
  ...over,
});

async function withWorkspacePair(run: (a: string, b: string) => Promise<void>): Promise<void> {
  const tag = randomBytes(6).toString("hex");
  const a = `ws_s73a_${tag}`;
  const b = `ws_s73b_${tag}`;
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2), ($3, $4)`, [a, `org_s73a_${tag}`, b, `org_s73b_${tag}`]);
  try {
    await run(a, b);
  } finally {
    await queryRows(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [a, b]);
  }
}

async function sloCount(workspaceId: string): Promise<number> {
  const [row] = await queryRows<{ n: string }>(`SELECT count(*)::text AS n FROM slos WHERE workspace_id = $1`, [workspaceId]);
  return Number(row.n);
}

test("the DSN this run was given answers, and it holds the 0012_slos migration", { skip }, async () => {
  try {
    assert.equal(await sloCount(`ws_s73_absent_${randomBytes(4).toString("hex")}`), 0);
  } catch (error) {
    assert.fail(`OBSTACK_TEST_POSTGRES_DSN is set but the store did not answer a read of slos — apply services/ingest/pgmigrations: ${String(error)}`);
  }
});

test("an SLO created in one workspace is invisible to the other, and its channel reference is workspace-scoped", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const tag = randomBytes(4).toString("hex");
    const aChannel = await withTransaction((q) => createNotificationChannel(a, { name: "#slo", kind: "webhook", target: `https://hooks.example.test/${tag}` }, q));
    const aSlo = await withTransaction((q) => createSlo(a, input({ channelId: aChannel.id }), q));
    const bSlo = await withTransaction((q) => createSlo(b, input(), q));

    assert.deepEqual((await listSlos(a, queryRows)).map((s) => s.id), [aSlo.id]);
    assert.deepEqual((await listSlos(b, queryRows)).map((s) => s.id), [bSlo.id]);
    assert.equal(aSlo.channelName, "#slo");
    assert.equal(bSlo.channelName, null);
    assert.equal(aSlo.status, "no-data");
    assert.equal(aSlo.currentPct, null);
    assert.equal(aSlo.target, 99.9);

    // b naming a's ids from inside b: the D440 sentences, and no row moves.
    await refusal(withTransaction((q) => updateSlo(b, aSlo.id, input({ name: "Hijacked" }), q)), "no SLO with this id in your workspace");
    await refusal(withTransaction((q) => setSloEnabled(b, aSlo.id, false, q)), "no SLO with this id in your workspace");
    await refusal(withTransaction((q) => createSlo(b, input({ name: "Stolen channel", channelId: aChannel.id }), q)), "no notification channel with this id in your workspace");
    const untouched = await withTransaction((q) => deleteSlo(b, aSlo.id, q));
    assert.deepEqual(untouched.map((s) => s.id), [bSlo.id]);
    assert.equal(await sloCount(a), 1);
    assert.equal((await listSlos(a, queryRows))[0].name, "API availability");
  });
});

test("a channel referenced by an SLO cannot be deleted — refused by the module, and by Postgres underneath it", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const tag = randomBytes(4).toString("hex");
    const channel = await withTransaction((q) => createNotificationChannel(a, { name: "#slo", kind: "webhook", target: `https://hooks.example.test/${tag}` }, q));
    const slo = await withTransaction((q) => createSlo(a, input({ channelId: channel.id }), q));

    await refusal(withTransaction((q) => deleteNotificationChannel(a, channel.id, q)), `“#slo” is used by 1 SLO — delete or repoint it first`);
    // The RESTRICT itself, past the module's check: Postgres refuses the raw delete.
    await assert.rejects(queryRows(`DELETE FROM notification_channels WHERE id = $1`, [channel.id]), (e: unknown) => (e as { code?: string }).code === "23503");

    await withTransaction((q) => deleteSlo(a, slo.id, q));
    const left = await withTransaction((q) => deleteNotificationChannel(a, channel.id, q));
    assert.deepEqual(left, []);
  });
});

test("measurements written by the evaluator read back as numbers, and an objective change resets them (D518)", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const slo = await withTransaction((q) => createSlo(a, input({ target: 99.95 }), q));
    await queryRows(
      `UPDATE slos SET status = 'breached', current_pct = 98.4, budget_burned_pct = 3200, good_count = 984, total_count = 1000,
              evaluated_at = now(), last_transition_at = now(), next_eval_at = now() + interval '5 minutes' WHERE id = $1`,
      [slo.id],
    );
    const [measured] = await listSlos(a, queryRows);
    assert.equal(measured.status, "breached");
    assert.equal(measured.currentPct, 98.4);
    assert.equal(measured.budgetBurnedPct, 3200);
    assert.equal(measured.goodCount, 984);
    assert.equal(measured.totalCount, 1000);
    assert.equal(measured.target, 99.95);
    assert.match(measured.evaluatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

    // A rename keeps the measurement.
    const renamed = await withTransaction((q) => updateSlo(a, slo.id, input({ name: "renamed", target: 99.95 }), q));
    assert.equal(renamed.status, "breached");
    assert.equal(renamed.goodCount, 984);

    // A target change resets it and asks for a fresh read now.
    const retargeted = await withTransaction((q) => updateSlo(a, slo.id, input({ name: "renamed", target: 99.5 }), q));
    assert.equal(retargeted.status, "no-data");
    assert.equal(retargeted.currentPct, null);
    assert.equal(retargeted.goodCount, null);
    assert.equal(retargeted.evaluatedAt, null);
    assert.equal(retargeted.lastTransitionAt, null);
    const [{ due }] = await queryRows<{ due: boolean }>(`SELECT next_eval_at <= now() AS due FROM slos WHERE id = $1`, [slo.id]);
    assert.equal(due, true);
  });
});

test("the events feed names an SLO's event by the SLO's name, and only in its own workspace", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const slo = await withTransaction((q) => createSlo(a, input(), q));
    await queryRows(
      `INSERT INTO alert_events (id, workspace_id, rule_id, slo_id, channel_id, severity, title, detail)
       VALUES ($1, $2, NULL, $3, NULL, 'critical', 'API availability: breached — 98.4% against a 99.9% target', 'seeded')`,
      [`evt_${randomBytes(8).toString("hex")}`, a, slo.id],
    );
    const [event] = await listAlertEvents(a, 10, queryRows);
    assert.equal(event.sloId, slo.id);
    assert.equal(event.sloName, "API availability");
    assert.equal(event.ruleId, null);
    assert.equal(event.ruleName, null);
    assert.equal((await listAlertEvents(b, 10, queryRows)).length, 0);

    // One producer per event: the 0012 CHECK refuses a row claiming both.
    await assert.rejects(
      queryRows(
        `INSERT INTO alert_events (id, workspace_id, rule_id, slo_id, severity, title) VALUES ($1, $2, 'rule_x', $3, 'info', 'x')`,
        [`evt_${randomBytes(8).toString("hex")}`, a, slo.id],
      ),
    );
    // And the SLO's events CASCADE with it.
    await withTransaction((q) => deleteSlo(a, slo.id, q));
    assert.equal((await listAlertEvents(a, 10, queryRows)).length, 0);
  });
});
