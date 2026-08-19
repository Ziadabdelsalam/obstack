import assert from "node:assert/strict";
import test from "node:test";
import { fakeBilling } from "./fake";
import { applyWebhook, reconcileCheckout } from "./reconcile";
import { normalizeWebhook } from "./webhook";

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

  // 2. Polar revokes it. D169: revocation is the cutoff.
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
