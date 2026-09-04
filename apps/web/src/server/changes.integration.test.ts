import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import {
  listChangeEvents,
  listChangeEventsInLeadIn,
  listChangeEventsInWindow,
  listServiceDeploys,
} from "./changes";
import { getPool, queryRows } from "./postgres";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait postgres ingest
// then:     OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//           npm test --workspace apps/web
//
// The rows-actually-disjoint half of the changes store (the
// `alerts.integration.test.ts` pattern): that events in one workspace are
// INVISIBLE to another on both reads, that the feed really orders by the
// event's own time when receipt order disagrees, and that the deploys read
// really excludes the other kinds and the other services. The rows are seeded
// straight into Postgres — the module has no writer, by design (packet §0).
//
// D36 class; the skip is deliberately NARROW: only when
// `OBSTACK_TEST_POSTGRES_DSN` is UNSET, never on a refused connection.

const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;

const skip = DSN
  ? undefined
  : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";

if (DSN) process.env.OBSTACK_POSTGRES_DSN = DSN;

const seeded: string[] = [];

after(async () => {
  if (!DSN) return;
  if (seeded.length > 0) {
    await queryRows("DELETE FROM workspaces WHERE id = ANY($1)", [seeded]);
  }
  await getPool().end();
});

async function workspace(): Promise<string> {
  const id = `ws_chgt_${randomBytes(6).toString("hex")}`;
  await queryRows("INSERT INTO workspaces (id, org_id) VALUES ($1, $2)", [id, `org_${id}`]);
  seeded.push(id);
  return id;
}

type Seed = {
  kind: string;
  title: string;
  at: Date;
  service?: string;
  ref?: string;
  link?: { label: string; href: string };
  /** Only the S7.4 tie-break test sets this: an id is otherwise random, and a
   *  claim about `ORDER BY at, id` needs two ids whose order is known. */
  id?: string;
};

async function seed(workspaceId: string, s: Seed): Promise<string> {
  const id = s.id ?? `chg_${randomBytes(8).toString("hex")}`;
  await queryRows(
    `INSERT INTO change_events (id, workspace_id, kind, title, who, service, ref, source, link_label, link_href, at)
     VALUES ($1, $2, $3, $4, 'seed', $5, $6, 'test', $7, $8, $9)`,
    [id, workspaceId, s.kind, s.title, s.service ?? null, s.ref ?? null, s.link?.label ?? null, s.link?.href ?? null, s.at],
  );
  return id;
}

const hour = 60 * 60 * 1000;

test("events in one workspace are invisible to another, on both reads", { skip }, async () => {
  const alice = await workspace();
  const bob = await workspace();
  const now = Date.now();

  await seed(alice, { kind: "deploy", title: "alice deploy", at: new Date(now - hour), service: "checkout", ref: "aaa1111" });
  await seed(alice, { kind: "config", title: "alice config", at: new Date(now - 2 * hour) });
  await seed(bob, { kind: "deploy", title: "bob deploy", at: new Date(now - hour), service: "checkout", ref: "bbb2222" });

  const aliceFeed = await listChangeEvents(alice, 50, queryRows);
  assert.deepEqual(
    aliceFeed.map((e) => e.title),
    ["alice deploy", "alice config"],
    "alice's feed must hold exactly her rows, newest-first",
  );
  const bobFeed = await listChangeEvents(bob, 50, queryRows);
  assert.deepEqual(bobFeed.map((e) => e.title), ["bob deploy"]);

  assert.deepEqual((await listServiceDeploys(alice, "checkout", 3, queryRows)).map((d) => d.ref), ["aaa1111"]);
  assert.deepEqual((await listServiceDeploys(bob, "checkout", 3, queryRows)).map((d) => d.ref), ["bbb2222"]);

  const nobody = await workspace();
  assert.deepEqual(await listChangeEvents(nobody, 50, queryRows), []);
  assert.deepEqual(await listServiceDeploys(nobody, "checkout", 3, queryRows), []);
});

test("the feed orders by the event's own time when receipt order disagrees, and honours the limit", { skip }, async () => {
  const ws = await workspace();
  const now = Date.now();
  // Received in this order; happened in the opposite one (a backfill).
  await seed(ws, { kind: "scale", title: "third", at: new Date(now - 3 * hour) });
  await seed(ws, { kind: "flag", title: "first", at: new Date(now - hour) });
  await seed(ws, { kind: "infra", title: "second", at: new Date(now - 2 * hour) });

  const feed = await listChangeEvents(ws, 50, queryRows);
  assert.deepEqual(feed.map((e) => e.title), ["first", "second", "third"]);
  assert.equal(feed[0]?.at, new Date(now - hour).toISOString());

  const two = await listChangeEvents(ws, 2, queryRows);
  assert.deepEqual(two.map((e) => e.title), ["first", "second"]);
});

test("the deploys read excludes other kinds, other services and other workspaces", { skip }, async () => {
  const ws = await workspace();
  const other = await workspace();
  const now = Date.now();
  await seed(ws, { kind: "deploy", title: "checkout new", at: new Date(now - hour), service: "checkout", ref: "new0001",
    link: { label: "run", href: "https://ci.example/2" } });
  await seed(ws, { kind: "deploy", title: "checkout old", at: new Date(now - 5 * hour), service: "checkout", ref: "old0001" });
  await seed(ws, { kind: "deploy", title: "api deploy", at: new Date(now - 2 * hour), service: "api", ref: "api0001" });
  await seed(ws, { kind: "config", title: "checkout config", at: new Date(now - hour), service: "checkout" });
  await seed(ws, { kind: "deploy", title: "no service", at: new Date(now - hour) });
  await seed(other, { kind: "deploy", title: "other checkout", at: new Date(now), service: "checkout", ref: "oth0001" });

  const deploys = await listServiceDeploys(ws, "checkout", 3, queryRows);
  assert.deepEqual(deploys.map((d) => d.ref), ["new0001", "old0001"]);
  assert.deepEqual(deploys[0]?.link, { label: "run", href: "https://ci.example/2" });
  assert.equal(deploys[1]?.link, null);
  assert.deepEqual((await listServiceDeploys(ws, "checkout", 1, queryRows)).map((d) => d.ref), ["new0001"]);
});

// ---- S7.4 D534/D535: the two timeline legs, proven at the boundary ----------

// `changes.test.ts` can only assert that the statements SAY `at >= $2 AND at <
// $3`. Whether Postgres agrees at the boundary row is a question only a real
// database answers — and the boundary here carries a second claim the alerts
// leg does not have: the incident's `started_at` is the shared edge between the
// lead-in band and the window, so the change AT that instant must land in
// exactly ONE of the two legs (D535). Not both, which would render one deploy
// twice, and not neither, which would drop it out of the timeline entirely.

const LEAD_IN_START = "2026-09-04T12:00:00.000Z";
const WINDOW_START = "2026-09-04T13:00:00.000Z";
const WINDOW_END = "2026-09-04T13:30:00.000Z";

const at = (base: string, deltaMs = 0): Date => new Date(Date.parse(base) + deltaMs);

test("the in-window leg includes the change AT the start and excludes the one AT the end", { skip }, async () => {
  const ws = await workspace();
  const other = await workspace();

  await seed(ws, { kind: "deploy", title: "one ms before the start", at: at(WINDOW_START, -1) });
  await seed(ws, { kind: "deploy", title: "exactly at the start", at: at(WINDOW_START) });
  await seed(ws, { kind: "config", title: "inside", at: at(WINDOW_START, 15 * 60 * 1000) });
  await seed(ws, { kind: "deploy", title: "exactly at the end", at: at(WINDOW_END) });
  await seed(ws, { kind: "deploy", title: "one ms after the end", at: at(WINDOW_END, 1) });
  await seed(other, { kind: "deploy", title: "the other tenant's", at: at(WINDOW_START) });

  const inWindow = await listChangeEventsInWindow(ws, WINDOW_START, WINDOW_END, 51, queryRows);
  assert.deepEqual(
    inWindow.map((e) => e.title),
    ["exactly at the start", "inside"],
    "the half-open window must take the row at `start` and leave the row at `end` to the next incident",
  );
  assert.deepEqual(inWindow.map((e) => e.at), [WINDOW_START, at(WINDOW_START, 15 * 60 * 1000).toISOString()]);

  // Neither exclusion is vacuous: both rows are really there, and it is the
  // BOUND that leaves them out.
  assert.deepEqual(
    (await listChangeEventsInWindow(ws, WINDOW_START, new Date(Date.parse(WINDOW_END) + 1).toISOString(), 51, queryRows)).map((e) => e.title),
    ["exactly at the start", "inside", "exactly at the end"],
  );
  assert.deepEqual(
    (await listChangeEventsInWindow(ws, new Date(Date.parse(WINDOW_START) - 1).toISOString(), WINDOW_END, 51, queryRows)).map((e) => e.title),
    ["one ms before the start", "exactly at the start", "inside"],
  );

  assert.deepEqual(
    (await listChangeEventsInWindow(other, WINDOW_START, WINDOW_END, 51, queryRows)).map((e) => e.title),
    ["the other tenant's"],
    "the window read leaked across workspaces",
  );
});

test("the change AT the incident's start belongs to the window leg and NOT the lead-in", { skip }, async () => {
  const ws = await workspace();
  await seed(ws, { kind: "deploy", title: "at the lead-in's own start", at: at(LEAD_IN_START) });
  await seed(ws, { kind: "deploy", title: "one ms before the lead-in", at: at(LEAD_IN_START, -1) });
  await seed(ws, { kind: "deploy", title: "the shared edge", at: at(WINDOW_START) });

  const leadIn = await listChangeEventsInLeadIn(ws, LEAD_IN_START, WINDOW_START, 21, queryRows);
  const window = await listChangeEventsInWindow(ws, WINDOW_START, WINDOW_END, 51, queryRows);

  assert.deepEqual(leadIn.map((e) => e.title), ["at the lead-in's own start"]);
  assert.deepEqual(window.map((e) => e.title), ["the shared edge"]);
  const both = [...leadIn, ...window].map((e) => e.title);
  assert.equal(new Set(both).size, both.length, "a change rendered twice: the two legs overlap at the shared edge");
});

test("the lead-in's cap keeps the changes NEAREST the incident, newest-first", { skip }, async () => {
  const ws = await workspace();
  const minute = 60 * 1000;
  for (const m of [55, 40, 25, 10, 5]) {
    await seed(ws, { kind: "deploy", title: `${m} minutes before`, at: at(WINDOW_START, -m * minute) });
  }
  // Three changes inside the window, and a lead-in read whose budget is
  // already spent: D535's defect is one ASC leg with ONE cap, where the five
  // rows above would eat the whole budget and render ZERO in-window changes.
  // Two reads, two caps — so the small lead-in cap cannot touch these three.
  await seed(ws, { kind: "deploy", title: "in-window 1", at: at(WINDOW_START, minute) });
  await seed(ws, { kind: "config", title: "in-window 2", at: at(WINDOW_START, 2 * minute) });
  await seed(ws, { kind: "flag", title: "in-window 3", at: at(WINDOW_START, 3 * minute) });

  const leadIn = await listChangeEventsInLeadIn(ws, LEAD_IN_START, WINDOW_START, 2, queryRows);
  assert.deepEqual(leadIn.map((e) => e.title), ["5 minutes before", "10 minutes before"]);

  const window = await listChangeEventsInWindow(ws, WINDOW_START, WINDOW_END, 51, queryRows);
  assert.deepEqual(window.map((e) => e.title), ["in-window 1", "in-window 2", "in-window 3"]);
});

test("both legs break ties on id, in each one's own direction", { skip }, async () => {
  const ws = await workspace();
  const tag = randomBytes(4).toString("hex");
  const tie = at(WINDOW_START, 10 * 60 * 1000);
  await seed(ws, { kind: "deploy", title: "higher id", at: tie, id: `chg_${tag}bbbb` });
  await seed(ws, { kind: "deploy", title: "lower id", at: tie, id: `chg_${tag}aaaa` });
  const leadInTie = at(WINDOW_START, -10 * 60 * 1000);
  await seed(ws, { kind: "deploy", title: "lead-in higher id", at: leadInTie, id: `chg_${tag}dddd` });
  await seed(ws, { kind: "deploy", title: "lead-in lower id", at: leadInTie, id: `chg_${tag}cccc` });

  assert.deepEqual(
    (await listChangeEventsInWindow(ws, WINDOW_START, WINDOW_END, 51, queryRows)).map((e) => e.title),
    ["lower id", "higher id"],
  );
  // The mirrored tie-break: without `id DESC` the lead-in's cap boundary would
  // be the planner's choice between two changes at one instant, so "the N
  // nearest" would not be a reproducible set.
  assert.deepEqual(
    (await listChangeEventsInLeadIn(ws, LEAD_IN_START, WINDOW_START, 21, queryRows)).map((e) => e.title),
    ["lead-in higher id", "lead-in lower id"],
  );
  assert.deepEqual(
    (await listChangeEventsInLeadIn(ws, LEAD_IN_START, WINDOW_START, 1, queryRows)).map((e) => e.title),
    ["lead-in higher id"],
  );
});
