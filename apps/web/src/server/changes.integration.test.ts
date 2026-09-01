import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { listChangeEvents, listServiceDeploys } from "./changes";
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
};

async function seed(workspaceId: string, s: Seed): Promise<string> {
  const id = `chg_${randomBytes(8).toString("hex")}`;
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
