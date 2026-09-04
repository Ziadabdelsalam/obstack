import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import {
  IncidentRefusal,
  MAX_INCIDENTS_PER_WORKSPACE,
  MAX_INCIDENT_TITLE,
  NO_SUCH_ALERT_EVENT,
  createIncident,
  deleteIncident,
  getIncident,
  listIncidents,
  listPromotableAlertEvents,
  promoteAlertEvent,
  reopenIncident,
  resolveIncident,
  updateIncident,
  type IncidentInput,
} from "./incidents";
import { getPool, queryRows, withTransaction } from "./postgres";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait postgres ingest
// then:     OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//           npm test --workspace apps/web
//
// The rows-actually-disjoint half of the incident store (the `slos.integration.
// test.ts` pattern): an incident created in one workspace is INVISIBLE to
// another, the promotion's scoped SELECT really is what shuts the cross-tenant
// copy — proven by showing that the FK alone accepts it — the cap really
// refuses at its boundary on both insert paths, the table CHECKs really refuse
// the states the module makes unreachable, and the retention sweep's SET NULL
// really leaves the FACT of the promotion behind. Self-skips only when the DSN
// is UNSET.

const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;
const skip = DSN ? undefined : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";
if (DSN) process.env.OBSTACK_POSTGRES_DSN = DSN;

after(async () => {
  if (DSN) await getPool().end();
});

async function refusal(work: Promise<unknown>, sentence: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof IncidentRefusal, `not an IncidentRefusal: ${String(error)}`);
    assert.equal((error as Error).message, sentence);
    return true;
  });
}

const NO_SUCH_INCIDENT = "no incident with this id in your workspace";

const input = (over: Partial<IncidentInput> = {}): IncidentInput => ({
  title: "Checkout latency",
  severity: "critical",
  summary: "p95 over two seconds",
  impact: "",
  startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  ...over,
});

async function withWorkspacePair(run: (a: string, b: string) => Promise<void>): Promise<void> {
  const tag = randomBytes(6).toString("hex");
  const a = `ws_s74a_${tag}`;
  const b = `ws_s74b_${tag}`;
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2), ($3, $4)`, [a, `org_s74a_${tag}`, b, `org_s74b_${tag}`]);
  try {
    await run(a, b);
  } finally {
    await queryRows(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [a, b]);
  }
}

async function incidentCount(workspaceId: string): Promise<number> {
  const [row] = await queryRows<{ n: string }>(`SELECT count(*)::text AS n FROM incidents WHERE workspace_id = $1`, [workspaceId]);
  return Number(row.n);
}

/** An `alert_events` row written the way the Go deliverer's producers write one
 *  — this module never writes that table (D544), so the fixture does. */
async function seedEvent(
  workspaceId: string,
  over: { title?: string; detail?: string; severity?: string } = {},
): Promise<string> {
  const id = `evt_${randomBytes(8).toString("hex")}`;
  await queryRows(
    `INSERT INTO alert_events (id, workspace_id, rule_id, slo_id, channel_id, severity, title, detail)
     VALUES ($1, $2, NULL, NULL, NULL, $3, $4, $5)`,
    [id, workspaceId, over.severity ?? "warning", over.title ?? "API availability: breached", over.detail ?? "98.4% against a 99.9% target"],
  );
  return id;
}

test("the DSN this run was given answers, and it holds the 0013_incidents migration", { skip }, async () => {
  try {
    assert.equal(await incidentCount(`ws_s74_absent_${randomBytes(4).toString("hex")}`), 0);
  } catch (error) {
    assert.fail(`OBSTACK_TEST_POSTGRES_DSN is set but the store did not answer a read of incidents — apply services/ingest/pgmigrations: ${String(error)}`);
  }
});

test("an incident created in one workspace is invisible to the other, header numbers included", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const older = await withTransaction((q) => createIncident(a, input({ title: "Checkout latency", startedAt: "2026-09-03T09:00:00.000Z" }), q));
    const newer = await withTransaction((q) => createIncident(a, input({ title: "Chat errors", startedAt: "2026-09-04T13:04:00.000Z" }), q));
    const bOnly = await withTransaction((q) => createIncident(b, input({ title: "b's own outage" }), q));
    await withTransaction((q) => resolveIncident(a, older.id, "2026-09-03T09:30:00.000Z", q));

    const pageA = await listIncidents(a, queryRows);
    const pageB = await listIncidents(b, queryRows);
    assert.deepEqual(pageA.incidents.map((i) => i.id), [newer.id, older.id], "the list orders by the incident's OWN start, newest first");
    assert.deepEqual(pageB.incidents.map((i) => i.id), [bOnly.id]);
    assert.deepEqual([pageA.total, pageA.ongoing], [2, 1]);
    assert.deepEqual([pageB.total, pageB.ongoing], [1, 1]);
    assert.equal(typeof pageA.ongoing, "number", "the ::int cast is what stops pg handing this back as a string");
    assert.equal(typeof pageA.total, "number");

    // The resolved row's pair really moved together, and the end is the one sent.
    assert.equal(pageA.incidents[1].status, "resolved");
    assert.equal(pageA.incidents[1].endedAt, "2026-09-03T09:30:00.000Z");
  });
});

test("the D440 sentences: an id that never existed and another tenant's answer identically, and nothing moves", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const mine = await withTransaction((q) => createIncident(a, input(), q));
    const invented = `inc_${randomBytes(8).toString("hex")}`;

    for (const id of [mine.id, invented]) {
      await refusal(withTransaction((q) => updateIncident(b, id, input({ title: "Hijacked" }), q)), NO_SUCH_INCIDENT);
      await refusal(withTransaction((q) => resolveIncident(b, id, null, q)), NO_SUCH_INCIDENT);
      await refusal(withTransaction((q) => reopenIncident(b, id, q)), NO_SUCH_INCIDENT);
      assert.equal(await getIncident(b, id, queryRows), null, "the detail read told the two ids apart");
      await withTransaction((q) => deleteIncident(b, id, q));
    }

    assert.equal(await incidentCount(a), 1);
    assert.equal(await incidentCount(b), 0);
    const [survivor] = (await listIncidents(a, queryRows)).incidents;
    assert.equal(survivor.title, "Checkout latency");
    assert.equal(survivor.status, "ongoing");
  });
});

test("promoting another tenant's event is refused and writes NOTHING — while the FK alone would have accepted it (D544)", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const aliceEvent = await seedEvent(a, { title: "alice's private rule fired", detail: "alice's private detail" });

    await refusal(withTransaction((q) => promoteAlertEvent(b, aliceEvent, q)), NO_SUCH_ALERT_EVENT);
    await refusal(withTransaction((q) => promoteAlertEvent(b, `evt_${randomBytes(8).toString("hex")}`, q)), NO_SUCH_ALERT_EVENT);
    // The leak proof is the ABSENCE of the row, not the presence of a sentence:
    // a hidden row is still a copied row.
    assert.equal(await incidentCount(b), 0, "bob's workspace holds a row promoted from alice's event");
    assert.equal(
      (await queryRows(`SELECT 1 FROM incidents WHERE opened_from_event_id = $1`, [aliceEvent])).length,
      0,
      "alice's event was promoted by someone",
    );

    // The counter-proof, run rather than asserted: the foreign key is satisfied
    // by ANOTHER tenant's event id, so Postgres raises nothing and the copy
    // would land. The scoped SELECT above is the only thing that stopped it.
    const smuggled = `inc_${randomBytes(8).toString("hex")}`;
    await queryRows(
      `INSERT INTO incidents (id, workspace_id, title, severity, started_at, origin, opened_from_event_id)
       VALUES ($1, $2, 'smuggled', 'warning', now(), 'alert', $3)`,
      [smuggled, b, aliceEvent],
    );
    const [{ ok }] = await queryRows<{ ok: boolean }>(
      `SELECT (i.workspace_id <> e.workspace_id) AS ok FROM incidents i JOIN alert_events e ON e.id = i.opened_from_event_id WHERE i.id = $1`,
      [smuggled],
    );
    assert.equal(ok, true, "the FK accepted a cross-workspace pointer — which is exactly why the store must not rely on it");
    await queryRows(`DELETE FROM incidents WHERE id = $1`, [smuggled]);
  });
});

test("a promotion derives every value from the event, and a second promotion returns the ORIGINAL row", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const eventId = await seedEvent(a, { title: "API availability: breached", detail: "98.4% against a 99.9% target", severity: "info" });
    const promoted = await withTransaction((q) => promoteAlertEvent(a, eventId, q));
    const again = await withTransaction((q) => promoteAlertEvent(a, eventId, q));

    assert.equal(again.id, promoted.id, "a second promotion minted a twin");
    assert.equal(await incidentCount(a), 1);

    // Read the derived values RAW, against the event's own row: no JS on either
    // side of the comparison.
    const [same] = await queryRows<Record<string, boolean | string>>(
      `SELECT i.title = e.title            AS title_copied,
              i.severity = e.severity      AS severity_copied,
              i.summary = e.detail         AS summary_copied,
              i.impact = ''                AS impact_empty,
              i.started_at = e.created_at  AS start_copied,
              i.opened_from_event_id = e.id AS pointer_set,
              i.origin                     AS origin,
              i.status                     AS status,
              i.ended_at IS NULL           AS open
         FROM incidents i
         JOIN alert_events e ON e.id = i.opened_from_event_id
        WHERE i.id = $1`,
      [promoted.id],
    );
    assert.deepEqual(same, {
      title_copied: true,
      severity_copied: true,
      summary_copied: true,
      impact_empty: true,
      start_copied: true,
      pointer_set: true,
      origin: "alert",
      status: "ongoing",
      open: true,
    });
    assert.equal(promoted.severity, "info", "the severity vocabulary is the alert one, identity-mapped (D525)");

    // The picker offers un-promoted events only, and never another tenant's.
    //
    // The foreign event is SEEDED deliberately (Path D, D549). Without a row in
    // `b` this assertion is vacuous against a fresh database: a picker with its
    // workspace predicate defanged has nothing to wrongly offer, so it stays
    // green while leaking. It only appeared to red on a dev database because
    // that database happened to hold unrelated `alert_events` rows — incidental,
    // not structural, and gone in CI.
    const second = await seedEvent(a, { title: "second event" });
    const foreign = await seedEvent(b, { title: "bob's own event" });
    const options = await listPromotableAlertEvents(a, 50, queryRows);
    assert.deepEqual(options.map((o) => o.id), [second]);
    assert.ok(
      !options.some((o) => o.id === foreign),
      "the picker offered another workspace's alert event — the scoped predicate is gone (D544/D549 path D)",
    );
    assert.ok(
      !options.some((o) => o.title === "bob's own event"),
      "another workspace's event TITLE reached this picker",
    );
  });
});

test("a 2001-character event detail promotes to a 2000-character summary — the OTHER half of D526's copy-site clip", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    // `alert_events.detail` has NO length CHECK (0010_alerts.sql:78) and
    // `incidents.summary` CHECKs at 2000, and the gap is REACHABLE: event_text.go
    // composes detail from a rule name and every k=v filter pair, none of which
    // the alert validator bounds. Unclipped, this promotion raises a raw 23514 —
    // not an IncidentRefusal — so the action cannot catch it by identity and the
    // sprint's headline creation path answers 500.
    const detail = "D".repeat(2001);
    const eventId = await seedEvent(a, { detail });
    const promoted = await withTransaction((q) => promoteAlertEvent(a, eventId, q));

    const [row] = await queryRows<{ incident_len: number; event_len: number; marked: boolean }>(
      `SELECT char_length(i.summary)::int AS incident_len, char_length(e.detail)::int AS event_len,
              i.summary = left(e.detail, $2) || '…' AS marked
         FROM incidents i JOIN alert_events e ON e.id = i.opened_from_event_id
        WHERE i.id = $1`,
      [promoted.id, 1999],
    );
    assert.equal(row.incident_len, 2000, "the summary was not clipped at the copy site");
    assert.equal(row.event_len, 2001, "the clip rewrote the EVENT's own detail");
    assert.ok(row.marked, "the clipped summary carries no marker");

    // And an ordinary-length detail is copied whole, so the clip is not a
    // blanket truncation.
    const short = await seedEvent(a, { detail: "98.4% against a 99.9% target" });
    const plain = await withTransaction((q) => promoteAlertEvent(a, short, q));
    assert.equal(plain.summary, "98.4% against a 99.9% target");
  });
});

test("a 300-character event title promotes to a 200-character incident title, and the event keeps its own (D526)", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const title = "A".repeat(300);
    const eventId = await seedEvent(a, { title });
    const promoted = await withTransaction((q) => promoteAlertEvent(a, eventId, q));

    const [row] = await queryRows<{ incident_len: number; event_len: number; marked: boolean }>(
      `SELECT char_length(i.title)::int AS incident_len, char_length(e.title)::int AS event_len,
              i.title = left(e.title, $2) || '…' AS marked
         FROM incidents i JOIN alert_events e ON e.id = i.opened_from_event_id
        WHERE i.id = $1`,
      [promoted.id, MAX_INCIDENT_TITLE - 1],
    );
    assert.equal(row.incident_len, MAX_INCIDENT_TITLE, "an unclipped copy would have raised the title CHECK as a 500");
    assert.equal(row.event_len, 300, "the copy site clipped the event's own row");
    assert.equal(row.marked, true, "the clip is stated, not silent");
  });
});

test("the cap refuses at its boundary on BOTH insert paths, and a delete gets the workspace back under it (D529)", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const tag = randomBytes(6).toString("hex");
    await queryRows(
      `INSERT INTO incidents (id, workspace_id, title, severity, started_at)
       SELECT 'inc_' || $2 || lpad(g::text, 4, '0'), $1, 'seeded ' || g, 'info', now() - (g || ' minutes')::interval
         FROM generate_series(1, $3) g`,
      [a, tag, MAX_INCIDENTS_PER_WORKSPACE - 1],
    );
    assert.equal(await incidentCount(a), MAX_INCIDENTS_PER_WORKSPACE - 1);

    const SENTENCE = `this workspace already has ${MAX_INCIDENTS_PER_WORKSPACE} incidents — the maximum; delete a resolved one to open another`;
    const eventId = await seedEvent(a);

    // One below the cap: the manual path takes the last slot.
    const last = await withTransaction((q) => createIncident(a, input({ title: "the last one" }), q));
    assert.equal(await incidentCount(a), MAX_INCIDENTS_PER_WORKSPACE);

    // At the cap: both paths refuse, in the same words, and neither writes.
    await refusal(withTransaction((q) => createIncident(a, input(), q)), SENTENCE);
    await refusal(withTransaction((q) => promoteAlertEvent(a, eventId, q)), SENTENCE);
    assert.equal(await incidentCount(a), MAX_INCIDENTS_PER_WORKSPACE);

    // The cap is PER WORKSPACE and counted as one: a neighbour sitting at it
    // does not spend b's allowance.
    await withTransaction((q) => createIncident(b, input({ title: "b's own outage" }), q));
    assert.equal(await incidentCount(b), 1);

    // The remedy the sentence names really works, and the promote path can take
    // the freed slot — so the cap is exitable from both sides.
    await withTransaction((q) => deleteIncident(a, last.id, q));
    const promoted = await withTransaction((q) => promoteAlertEvent(a, eventId, q));
    assert.equal(await incidentCount(a), MAX_INCIDENTS_PER_WORKSPACE);
    assert.equal(promoted.origin, "alert");
    await refusal(withTransaction((q) => createIncident(a, input(), q)), SENTENCE);
  });
});

test("the server stamps the end when the caller sends none, and an end before the start is refused (D527)", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const incident = await withTransaction((q) => createIncident(a, input({ startedAt: "2026-09-04T13:04:00.000Z" }), q));

    await refusal(withTransaction((q) => resolveIncident(a, incident.id, "2026-09-04T12:00:00.000Z", q)), "an incident cannot end before it started");
    const [{ still_open }] = await queryRows<{ still_open: boolean }>(`SELECT ended_at IS NULL AS still_open FROM incidents WHERE id = $1`, [incident.id]);
    assert.equal(still_open, true);

    const resolved = await withTransaction((q) => resolveIncident(a, incident.id, null, q));
    assert.equal(resolved.status, "resolved");
    const [stamped] = await queryRows<{ from_server: boolean; after_start: boolean }>(
      `SELECT ended_at BETWEEN now() - interval '1 minute' AND now() AS from_server,
              ended_at >= started_at AS after_start
         FROM incidents WHERE id = $1`,
      [incident.id],
    );
    assert.deepEqual(stamped, { from_server: true, after_start: true });

    const reopened = await withTransaction((q) => reopenIncident(a, incident.id, q));
    assert.equal(reopened.status, "ongoing");
    assert.equal(reopened.endedAt, null);
  });
});

test("the two table CHECKs refuse the states the module makes unreachable", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const raw = (columns: string, values: string, params: unknown[]) =>
      queryRows(`INSERT INTO incidents (id, workspace_id, title, severity, started_at${columns}) VALUES ($1, $2, 'raw', 'info', now()${values})`, params);
    const violation = (e: unknown) => (e as { code?: string }).code === "23514";

    // (status = 'resolved') = (ended_at IS NOT NULL), both halves.
    await assert.rejects(raw(`, status`, `, 'resolved'`, [`inc_${randomBytes(8).toString("hex")}`, a]), violation);
    await assert.rejects(raw(`, ended_at`, `, now()`, [`inc_${randomBytes(8).toString("hex")}`, a]), violation);
    // ended_at >= started_at.
    await assert.rejects(
      raw(`, status, ended_at`, `, 'resolved', now() - interval '1 hour'`, [`inc_${randomBytes(8).toString("hex")}`, a]),
      violation,
    );
    assert.equal(await incidentCount(a), 0);
  });
});

test("sweeping a promoted alert event nulls the pointer and leaves the FACT of the promotion (D526)", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const eventId = await seedEvent(a, { title: "the event that aged out" });
    const promoted = await withTransaction((q) => promoteAlertEvent(a, eventId, q));
    assert.equal(promoted.openedFromEventId, eventId);

    // The retention sweep's own action, on this workspace's own event.
    await queryRows(`DELETE FROM alert_events WHERE id = $1`, [eventId]);

    const after = await getIncident(a, promoted.id, queryRows);
    assert.equal(after?.openedFromEventId, null, "ON DELETE SET NULL did not fire");
    assert.equal(after?.origin, "alert", "the incident now reads as manual — the fact of the promotion was erased");
    assert.equal(after?.title, "the event that aged out", "CASCADE deleted an operator's incident");
    assert.equal((await listPromotableAlertEvents(a, 50, queryRows)).length, 0);
  });
});
