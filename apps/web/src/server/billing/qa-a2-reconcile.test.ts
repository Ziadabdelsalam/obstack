import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { fakeBilling, setFakeSubscription } from "./fake";
import {
  applyWebhook,
  reconcileCheckout,
  reconcileCheckoutReturn,
  syncPlanFromRail,
} from "./reconcile";
import { normalizeWebhook } from "./webhook";
import type { BillingClient, SubscriptionState, WebhookEvent } from "./types";
import { getPool, queryRows, withTransaction, type QueryRows } from "@/server/postgres";

// run with: npm test --workspace apps/web
// DESTINATION: apps/web/src/server/billing/qa-a2-reconcile.test.ts
//
// S3.3 QA area A2 — billing hostile input. Destructive repros only; every test
// here asserts the behaviour the product SHOULD have, so a red IS the bug.
//
// No Polar, no Postgres: the fake is the rail under test (D168) and `queryRows`
// is injected on the D113 seam, so the sequences below are the production code
// paths with the two I/O ends recorded rather than mocked away. Each was driven
// first against the running product (production build, OBSTACK_DATA_MODE=live,
// OBSTACK_BILLING_MODE unset ⇒ fake) before being written down here.
delete process.env.OBSTACK_BILLING_MODE;
delete process.env.POLAR_ACCESS_TOKEN;
delete process.env.POLAR_WEBHOOK_SECRET;

const WS = "ws_qa_a2_alice";

/** Every plan-row write, in order — the only thing billing is allowed to change. */
function planWrites() {
  const writes: { workspaceId: string; planId: string }[] = [];
  const query = async <Row>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    if (sql.includes("workspace_plans")) {
      writes.push({ workspaceId: String(params[0]), planId: String(params[1]) });
    }
    return [] as Row[];
  };
  return { writes, query: query as never };
}

/** The refusal paths log by design (D190); this keeps the runner's output readable. */
async function quiet<T>(body: () => Promise<T>): Promise<T> {
  const realError = console.error;
  const realWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await body();
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
}

const subscriptionEvent = (type: string) =>
  normalizeWebhook({
    type,
    data: { id: "sub_qa_a2", customerId: `cus_${WS}`, customer: { externalId: WS } },
  });

/**
 * B2-1 — S2 — a SPENT checkout id re-grants a plan that was revoked.
 *
 * Driven against the running product first: alice upgrades through the real
 * `startCheckout` action, `subscription.revoked` returns her to free per D169
 * ("revocation is the cutoff"), and then re-opening the bookmarked return URL
 * `/app/settings?checkout=chk_8e6d2ed05509ecc2` answers
 * `307 → /app/settings?upgraded=1` and `workspace_plans.plan_id` reads `pro`
 * again — no payment and no live subscription.
 *
 * `reconcileCheckout` has no notion of a checkout having already been spent:
 * Polar keeps a succeeded checkout succeeded forever, so the id in the URL is a
 * permanent, replayable entitlement token in the hands of whoever cancelled.
 */
test("B2-1: a revoked plan is not resurrected by replaying the old ?checkout= id", async () => {
  const { writes, query } = planWrites();
  const created = await fakeBilling.createCheckout({
    workspaceId: WS,
    planId: "pro",
    returnPath: "/app/settings",
  });

  // 1. the honest return: the plan row moves to pro.
  const first = await quiet(() => reconcileCheckout(created.checkoutId, WS, query));
  assert.equal(first.applied, true, "precondition: the honest return applies");
  assert.deepEqual(writes.at(-1), { workspaceId: WS, planId: "pro" });

  // 2. Polar revokes it. D169: revocation is the cutoff. The rail's present
  // state moves to no-subscription, and the revoked webhook is the DOORBELL that
  // makes us re-read it — the event carries no plan, it only says "look again".
  setFakeSubscription(WS, null);
  await quiet(() => applyWebhook(subscriptionEvent("subscription.revoked"), query));
  assert.deepEqual(
    writes.at(-1),
    { workspaceId: WS, planId: "free" },
    "precondition: revoked returns the workspace to free",
  );

  // 3. the cancelled customer re-opens the bookmark she still has.
  const replay = await quiet(() => reconcileCheckout(created.checkoutId, WS, query));

  assert.deepEqual(
    writes.at(-1),
    { workspaceId: WS, planId: "free" },
    "a spent checkout id must not write a plan again after the revocation that ended it",
  );
  assert.equal(replay.applied, false, "a checkout already reconciled has nothing left to apply");
});

/**
 * The D176 tripwire, as the charter scopes it: a stranger's succeeded checkout
 * id must refuse AND leave the plan row provably unmoved. GREEN today — kept so
 * that a fix for B2-1 cannot quietly relax the comparison it sits beside.
 *
 * Verified in the running product: bob pasting alice's id answered
 * `307 → ?error=checkout-unconfirmed`, `workspace_plans` gained no row for bob,
 * and the server log carried the tripwire at `error` level.
 */
test("B2-A2: a stranger's checkout id refuses, writes nothing, and says why at error level", async () => {
  const { writes, query } = planWrites();
  const alices = await fakeBilling.createCheckout({
    workspaceId: WS,
    planId: "pro",
    returnPath: "/app/settings",
  });

  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  let result;
  try {
    result = await reconcileCheckout(alices.checkoutId, "ws_qa_a2_bob", query);
  } finally {
    console.error = realError;
  }

  assert.equal(result.applied, false);
  assert.deepEqual(writes, [], "the refused workspace's plan row is never touched");
  assert.match(logged.join("\n"), /belongs to another workspace/);
});

// --------------------------------------------------------------------------
// The advisory-lock serialization (D195.4), against REAL Postgres — the last
// race convergence alone does not close: two syncs of one workspace whose rail
// reads straddle a state change. `pg_advisory_xact_lock(hashtext(workspace_id))`
// makes the read→write of one sync complete before the other's begins, so the
// LATER present always wins. This needs a real lock, so it dials the compose
// Postgres; unset DSN skips it (deploy/compose/README.md), like qa-a4.
// --------------------------------------------------------------------------
const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;
const skip = DSN
  ? undefined
  : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";
const pool = DSN ? new Pool({ connectionString: DSN, max: 8, application_name: "qa-a2" }) : undefined;

// The return-path guard drives the PRODUCTION door `reconcileCheckoutReturn`,
// which opens its own transaction on the MODULE pool (`getPool`) — so it dials
// the same test Postgres, and the pool is closed alongside ours below.
if (DSN) process.env.OBSTACK_POSTGRES_DSN = DSN;

after(async () => {
  if (pool) await pool.end();
  if (DSN) await getPool().end();
});

const q = (client: Pool | PoolClient): QueryRows =>
  async <Row extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<Row[]> =>
    (await client.query<Row>(sql, params)).rows;

/** A rail whose subscription read is observable and, optionally, held open. */
function railAnswering(
  state: SubscriptionState,
  hooks: { onRead?: () => void; gate?: Promise<void> } = {},
): BillingClient {
  return {
    ...fakeBilling,
    getSubscriptionState: async () => {
      hooks.onRead?.();
      if (hooks.gate) await hooks.gate;
      return state;
    },
  };
}

test(
  "the advisory lock serializes two concurrent syncs — the second reads after the first commits",
  { skip },
  async () => {
    const tag = randomBytes(6).toString("hex");
    const ws = `ws_a2s_${tag}`;
    await q(pool as Pool)(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2)`, [
      ws,
      `org_a2s_${tag}`,
    ]);

    try {
      // A acquires the lock, then blocks INSIDE its rail read holding it.
      let aReading!: () => void;
      const aEnteredRead = new Promise<void>((r) => (aReading = r));
      let releaseA!: () => void;
      const gateA = new Promise<void>((r) => (releaseA = r));
      const railA = railAnswering(
        { active: true, customerId: "cus_a", subscriptionId: "sub_a" },
        { onRead: aReading, gate: gateA },
      );

      // B's read is observable; if it fires while A holds the lock, the lock
      // did not serialize. With the lock, B blocks in `lockWorkspace` until A
      // commits, and only then reads — the LATER present (revoked ⇒ free).
      let bRead = false;
      const railB = railAnswering(
        { active: false, customerId: null, subscriptionId: null },
        { onRead: () => (bRead = true) },
      );

      // Each sync opens its own transaction through the PRODUCTION door
      // `withTransaction` (the only source of the `TxQuery` syncPlanFromRail
      // demands, D199), on its own pooled connection — the shape the webhook
      // route gives it. A holds the advisory lock across its gated rail read.
      const aDone = withTransaction((query) => syncPlanFromRail(ws, query, railA));
      await aEnteredRead; // A now holds the advisory lock and is mid-read

      const bDone = withTransaction((query) => syncPlanFromRail(ws, query, railB));

      // Give B ample time to reach its rail read if it were NOT blocked. The
      // advisory lock A holds must keep it in `lockWorkspace` instead.
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(
        bRead,
        false,
        "B read the rail while A held the workspace lock — the read→write did not serialize",
      );

      releaseA();
      await Promise.all([aDone, bDone]);
      assert.equal(bRead, true, "B proceeds once A commits and releases the lock");

      // The later sync (B, revoked) wins: the row converges to free.
      const [row] = await q(pool as Pool)<{ plan_id: string }>(
        `SELECT plan_id FROM workspace_plans WHERE workspace_id = $1`,
        [ws],
      );
      assert.equal(row.plan_id, "free", "the last committed present is what the row holds");
    } finally {
      await q(pool as Pool)(`DELETE FROM workspaces WHERE id = $1`, [ws]); // CASCADE drops the plan row
    }
  },
);

// --------------------------------------------------------------------------
// D198 — the SAME serialization on the RETURN PATH, proven through the
// production door `reconcileCheckoutReturn`. F6 shipped the lock effective on
// the webhook path (route.ts `withTransaction`) but a no-op on the return path,
// which called `reconcileCheckout` with a plain pooled `queryRows`. The lock
// now lives structurally: `reconcileCheckoutReturn` opens the transaction, so
// two concurrent returns of one workspace serialize with no caller discipline.
// Red-provable by restoring the pooled-client path — reconcile through the pool
// (`reconcileCheckout(id, ws, queryRows, rail)` with `queryRows` forced past the
// brand) instead of through this door, and B reads the rail while A holds the
// lock (the lock releases inside its own implicit transaction), so the
// `bRead === false` assertion fails.
// --------------------------------------------------------------------------

/** A rail whose checkout is a succeeded, bound trigger and whose subscription read is observable. */
function returnRail(
  ws: string,
  state: SubscriptionState,
  hooks: { onRead?: () => void; gate?: Promise<void> } = {},
): BillingClient {
  return {
    ...fakeBilling,
    getCheckout: async () => ({ status: "succeeded", externalCustomerId: ws }),
    getSubscriptionState: async () => {
      hooks.onRead?.();
      if (hooks.gate) await hooks.gate;
      return state;
    },
  };
}

test(
  "the return path serializes too — reconcileCheckoutReturn owns the lock (D198)",
  { skip },
  async () => {
    const tag = randomBytes(6).toString("hex");
    const ws = `ws_a2r_${tag}`;
    await q(pool as Pool)(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2)`, [
      ws,
      `org_a2r_${tag}`,
    ]);

    try {
      // A: its returning checkout is bound and succeeded, its subscription is
      // active — but its rail read blocks INSIDE `reconcileCheckoutReturn`'s
      // transaction holding the workspace lock.
      let aReading!: () => void;
      const aEnteredRead = new Promise<void>((r) => (aReading = r));
      let releaseA!: () => void;
      const gateA = new Promise<void>((r) => (releaseA = r));
      const railA = returnRail(
        ws,
        { active: true, customerId: "cus_a", subscriptionId: "sub_a" },
        { onRead: aReading, gate: gateA },
      );

      // B: same workspace, its rail read observable; if it fires while A holds
      // the lock the return path did not serialize. Its later present is revoked.
      let bRead = false;
      const railB = returnRail(ws, { active: false, customerId: null, subscriptionId: null }, {
        onRead: () => (bRead = true),
      });

      const aDone = reconcileCheckoutReturn("chk_a", ws, railA);
      await aEnteredRead; // A holds the advisory lock in its own transaction, mid-read

      const bDone = reconcileCheckoutReturn("chk_b", ws, railB);

      // Ample time for B to reach its rail read if it were NOT blocked. The lock
      // A holds must keep it in `lockWorkspace` instead.
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(
        bRead,
        false,
        "B read the rail while A held the workspace lock — the return path did not serialize",
      );

      releaseA();
      const [aResult, bResult] = await Promise.all([aDone, bDone]);
      assert.equal(bRead, true, "B proceeds once A commits and releases the lock");
      assert.deepEqual(aResult, { applied: true, planId: "pro" }, "A's return applies the upgrade");
      assert.deepEqual(bResult, { applied: false }, "B's return converges to the revoked present");

      // The later return (B, revoked) wins: the row converges to free.
      const [row] = await q(pool as Pool)<{ plan_id: string }>(
        `SELECT plan_id FROM workspace_plans WHERE workspace_id = $1`,
        [ws],
      );
      assert.equal(row.plan_id, "free", "the last committed present is what the row holds");
    } finally {
      await q(pool as Pool)(`DELETE FROM workspaces WHERE id = $1`, [ws]); // CASCADE drops the plan row
    }
  },
);

// --------------------------------------------------------------------------
// D199 — the compile-refusal proof for the three billing lock-dependent writes.
// `TxQuery` is a phantom `unique symbol` brand, so a plain pooled `queryRows` is
// not assignable where the advisory lock must actually hold, and every function
// below refuses one at the TYPE level. This arrow is DEFINED and never invoked:
// `next build` type-checks it (tsc over `**/*.ts`), so each `@ts-expect-error`
// must fire or the build fails with an unused-directive error; `tsx` strips the
// types at runtime and never calls the arrow, so nothing here touches a pool.
// Deleting any one brand (retyping the parameter back to `QueryRows`) turns its
// directive unused and reddens the build — the idiom is enforced, not documented.
// --------------------------------------------------------------------------
void (async (): Promise<void> => {
  const event = {} as WebhookEvent;
  // @ts-expect-error a plain pooled `queryRows` is not the branded `TxQuery`
  await syncPlanFromRail(WS, queryRows);
  // @ts-expect-error idem — reconcileCheckout's third arg demands `TxQuery`
  await reconcileCheckout("chk", WS, queryRows);
  // @ts-expect-error idem — applyWebhook's `query` demands `TxQuery`
  await applyWebhook(event, queryRows);
});
