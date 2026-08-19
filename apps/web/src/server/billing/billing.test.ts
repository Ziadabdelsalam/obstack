import assert from "node:assert/strict";
import test from "node:test";
import { fakeBilling, signFakeWebhook, FAKE_SIGNATURE_HEADER } from "./fake";
import { normalizeWebhook } from "./webhook";
import { applyWebhook, reconcileCheckout, type ReconcileResult } from "./reconcile";
import { billingMode, createBillingClient } from "./client";
import { CHECKOUT_RETURN_PARAM, UnknownCheckout, type WebhookEvent } from "./types";

// run with: npm test --workspace apps/web
//
// The billing contract (D168/D169), proven against the fake — which is the
// point of the fake: it is the real rail with the third party removed, so the
// paths below are the production paths and not a rehearsal of them. Nothing
// here reaches Polar, nothing here needs a Postgres (`queryRows` is injected,
// the D113 pattern), and nothing here reads a secret.
//
// This process has NO billing environment at all, which is what makes the
// default-mode assertions mean something.
delete process.env.OBSTACK_BILLING_MODE;
delete process.env.POLAR_ACCESS_TOKEN;
delete process.env.POLAR_WEBHOOK_SECRET;

/** A recording `queryRows`: every statement and its bindings, and no database. */
function recorder() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = async <Row>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    calls.push({ sql, params });
    return [];
  };
  return { calls, query: query as never };
}

/**
 * The loud lines, as an operator would read them. Refusals carry their reason
 * in a log rather than a return value (D190), so the log IS the assertion — a
 * tripwire nobody can read is not a tripwire.
 */
async function capturingErrors<T>(body: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    return { result: await body(), logged };
  } finally {
    console.error = real;
  }
}

test("the default mode is the fake, and it never needs a Polar secret (D168)", () => {
  assert.equal(billingMode(), "fake");
  assert.equal(createBillingClient("fake").mode, "fake");
});

test("polar-sandbox without a token refuses loudly rather than falling back (D168)", () => {
  // The failure that must NOT be possible is a silent fall-through to the fake:
  // it would take a plan change nobody was ever charged for. The message names
  // the missing variable — and nothing else, because an error message is a log
  // line and a token in a log line is a leaked token.
  assert.throws(
    () => createBillingClient("polar-sandbox"),
    (error: Error) => {
      assert.match(error.message, /POLAR_ACCESS_TOKEN is required/);
      assert.ok(!/polar_oat_/.test(error.message), "no credential shape in the message");
      return true;
    },
  );
});

test("an unknown OBSTACK_BILLING_MODE is refused, not guessed at", () => {
  process.env.OBSTACK_BILLING_MODE = "polar";
  try {
    assert.throws(billingMode, /must be "fake" or "polar-sandbox"/);
  } finally {
    delete process.env.OBSTACK_BILLING_MODE;
  }
});

test("a fake checkout returns to OUR return path carrying its id", async () => {
  const created = await fakeBilling.createCheckout({
    workspaceId: "ws_alpha",
    planId: "pro",
    returnPath: "/app/settings",
  });

  // The whole reason the fake is worth having: the drive follows this URL and
  // exercises the real return-reconciliation path with zero third parties.
  assert.equal(created.url, `/app/settings?${CHECKOUT_RETURN_PARAM}=${created.checkoutId}`);

  const state = await fakeBilling.getCheckout(created.checkoutId);
  assert.equal(state.status, "succeeded");
  assert.equal(state.externalCustomerId, "ws_alpha", "one Polar customer per workspace (D110)");
  assert.equal(state.planId, "pro");
  assert.ok(state.subscriptionId);
});

test("an id the rail never issued is UnknownCheckout, exactly as Polar 404s", async () => {
  await assert.rejects(() => fakeBilling.getCheckout("chk_nope"), UnknownCheckout);
});

test("ingestUsage deduplicates on externalId and counts the duplicates honestly (D170)", async () => {
  const event = (externalId: string) => ({
    externalCustomerId: "ws_alpha",
    externalId,
    name: "ingest.events",
    timestamp: new Date("2026-08-19T10:00:00Z"),
    metadata: { spans: 3, logs: 1, events: 4 },
  });
  const window = `usage:ws_alpha:${Math.random()}`;

  const first = await fakeBilling.ingestUsage([event(window)]);
  assert.deepEqual(first, { inserted: 1, duplicates: 0 });

  // The reporter re-sends the last 24h of closed windows on every run and keeps
  // no send-log (D170). That is only correct if a re-send is genuinely free —
  // so the fake really deduplicates, and this really proves it.
  const again = await fakeBilling.ingestUsage([event(window), event(`${window}:next`)]);
  assert.deepEqual(again, { inserted: 1, duplicates: 1 });
});

test("verifyWebhook rejects a body whose signature does not cover it", () => {
  const body = JSON.stringify({ type: "checkout.updated", data: { id: "chk_1" } });
  const signature = signFakeWebhook(body);

  // Right signature, tampered body: the signature is over BYTES, which is why
  // the route hands the raw body over before anything parses it (D169).
  assert.throws(
    () => fakeBilling.verifyWebhook(`${body} `, { [FAKE_SIGNATURE_HEADER]: signature }),
    /signature does not match/,
  );
  assert.throws(() => fakeBilling.verifyWebhook(body, {}), /signature does not match/);
  assert.throws(
    () => fakeBilling.verifyWebhook(body, { [FAKE_SIGNATURE_HEADER]: "00" }),
    /signature does not match/,
  );
});

test("verifyWebhook accepts a correctly signed body and normalises it", () => {
  const body = JSON.stringify({
    type: "checkout.updated",
    data: { id: "chk_1", status: "succeeded", externalCustomerId: "ws_alpha" },
  });
  const event = fakeBilling.verifyWebhook(body, {
    [FAKE_SIGNATURE_HEADER]: signFakeWebhook(body),
  });
  assert.deepEqual(event, {
    consumed: "checkout",
    type: "checkout.updated",
    checkoutId: "chk_1",
    workspaceId: "ws_alpha",
    succeeded: true,
  });
});

test("the consumed set is exactly D169's, and everything else is an ACK", () => {
  const subscription = (type: string) => ({
    type,
    data: { id: "sub_1", customerId: "cus_1", customer: { externalId: "ws_alpha" } },
  });

  // Active in any of its four spellings means pro; the two end states mean
  // free. `past_due` is the ruled precision: Polar is merchant of record and
  // owns dunning, so a past-due subscription KEEPS its entitlements and the
  // revocation that may follow is the cutoff.
  for (const type of [
    "subscription.created",
    "subscription.updated",
    "subscription.active",
    "subscription.uncanceled",
  ]) {
    const event = normalizeWebhook(subscription(type));
    assert.equal(event.consumed, "plan", type);
    assert.equal(event.consumed === "plan" && event.planId, "pro", type);
  }
  for (const type of ["subscription.canceled", "subscription.revoked"]) {
    const event = normalizeWebhook(subscription(type));
    assert.equal(event.consumed, "plan", type);
    assert.equal(event.consumed === "plan" && event.planId, "free", type);
  }
  for (const type of [
    "subscription.past_due",
    "order.created",
    "order.paid",
    "customer.created",
    "benefit.created",
    "",
  ]) {
    assert.equal(normalizeWebhook(subscription(type)).consumed, "none", type);
  }
});

test("normalizeWebhook is total over shapes we did not author (D68)", () => {
  // It runs on a body a third party sent, after a signature check that says who
  // sent it and nothing about its shape. Every one of these must be an ACK
  // rather than a throw — a 500 here would earn ten retries of the same 500.
  for (const payload of [
    null,
    undefined,
    42,
    "checkout.updated",
    [],
    { type: 7 },
    { type: "checkout.updated" },
    { type: "checkout.updated", data: null },
    { type: "checkout.updated", data: { id: "chk_1" } },
    { type: "checkout.updated", data: { id: "", externalCustomerId: "ws" } },
    { type: "subscription.active", data: { id: "sub_1" } },
    { type: "subscription.active", data: { id: "sub_1", customer: "ws_alpha" } },
    { type: "subscription.active", data: { id: "sub_1", customer: { externalId: 5 } } },
    { type: Object.create(null) },
  ]) {
    assert.equal(normalizeWebhook(payload).consumed, "none", JSON.stringify(payload ?? null));
  }
});

test("reconcileCheckout writes the plan row on a succeeded checkout (D168)", async () => {
  const created = await fakeBilling.createCheckout({
    workspaceId: "ws_alpha",
    planId: "pro",
    returnPath: "/app/settings",
  });
  const store = recorder();

  const result = await reconcileCheckout(created.checkoutId, "ws_alpha", store.query);
  assert.deepEqual(result, { applied: true, planId: "pro" } satisfies ReconcileResult);

  assert.equal(store.calls.length, 1, "one statement, one row");
  const [call] = store.calls;
  assert.match(call.sql, /INSERT INTO workspace_plans/);
  assert.match(call.sql, /ON CONFLICT \(workspace_id\) DO UPDATE/, "idempotent by construction");
  assert.equal(call.params[0], "ws_alpha", "the workspace is bound as $1 (D11/D148)");
  assert.equal(call.params[1], "pro");
  assert.equal(call.params[2], "cus_ws_alpha");
  assert.ok(String(call.params[3]).startsWith("sub_"));
  // Nothing a caller supplied may be interpolated into the statement.
  assert.ok(!call.sql.includes("ws_alpha"), "values are bound, never spliced");
});

test("reconcileCheckout refuses another workspace's checkout and writes nothing (D148)", async () => {
  // The checkout id arrives on the return path as a URL parameter, so it is
  // whatever someone typed. Without this comparison, pasting a stranger's
  // succeeded checkout id would write THEIR plan onto YOUR workspace.
  const created = await fakeBilling.createCheckout({
    workspaceId: "ws_stranger",
    planId: "pro",
    returnPath: "/app/settings",
  });
  const store = recorder();

  const { result, logged } = await capturingErrors(() =>
    reconcileCheckout(created.checkoutId, "ws_mine", store.query),
  );

  assert.deepEqual(result, { applied: false });
  assert.equal(store.calls.length, 0, "no statement ran at all");
  // This line is the security tripwire (D176/D190): the refusal is silent
  // everywhere else, so if it stops being logged nobody learns it happened.
  assert.equal(logged.length, 1, "one loud line, and one only");
  assert.match(logged[0], /^\[billing\] checkout "\S+" belongs to another workspace/);
  assert.ok(!logged[0].includes("ws_stranger"), "the refusal names the checkout, not the owner");
});

test("a refusal line cannot be forged by the id it names", async () => {
  // The id is whatever was in the address bar, so an unquoted newline in it
  // would let a caller write their own "belongs to another workspace" line —
  // or push the real one out of an operator's sight. Quoting is the fix.
  const forged = "chk_x\n[billing] checkout chk_y is unknown to the rail";
  const store = recorder();
  const { logged } = await capturingErrors(() =>
    reconcileCheckout(forged, "ws_alpha", store.query),
  );

  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes("\n"), "one id, one line");
});

test("reconcileCheckout treats an id the rail never issued as nothing to do", async () => {
  const store = recorder();
  const { result, logged } = await capturingErrors(() =>
    reconcileCheckout("chk_hostile", "ws_alpha", store.query),
  );
  assert.deepEqual(result, { applied: false });
  assert.equal(store.calls.length, 0);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /\[billing\] checkout "chk_hostile" is unknown to the rail/);
});

test("a succeeded checkout with no plan to write is refused loudly, not guessed at", async () => {
  // Guessing a plan here is how a free workspace becomes a paid row nobody
  // sold, so the only safe answer is to write nothing and say so.
  const created = await fakeBilling.createCheckout({
    workspaceId: "ws_alpha",
    planId: "",
    returnPath: "/app/settings",
  });
  const store = recorder();

  const { result, logged } = await capturingErrors(() =>
    reconcileCheckout(created.checkoutId, "ws_alpha", store.query),
  );

  assert.deepEqual(result, { applied: false });
  assert.equal(store.calls.length, 0, "no statement ran at all");
  assert.equal(logged.length, 1);
  assert.match(logged[0], /succeeded with no plan id/);
});

// Recorded narrowing: three of `reconcileCheckout`'s five refusal branches are
// proven above. The pending and expired ones are NOT reachable here — a fake
// checkout succeeds at creation (D168), so reaching them needs a stand-in for
// `getBilling()`, an injection seam D190 did not rule. Their loud lines are
// therefore unguarded: deleting one goes green.

test("applyWebhook is the same reconciliation the return path uses (one definition)", async () => {
  const created = await fakeBilling.createCheckout({
    workspaceId: "ws_alpha",
    planId: "pro",
    returnPath: "/app/settings",
  });
  const store = recorder();

  await applyWebhook(
    {
      consumed: "checkout",
      type: "checkout.updated",
      checkoutId: created.checkoutId,
      workspaceId: "ws_alpha",
      succeeded: true,
    },
    store.query,
  );

  assert.equal(store.calls.length, 1);
  assert.deepEqual(store.calls[0].params.slice(0, 2), ["ws_alpha", "pro"]);
});

test("applyWebhook writes a subscription's plan and ACKs everything else", async () => {
  const store = recorder();

  await applyWebhook(
    {
      consumed: "plan",
      type: "subscription.revoked",
      workspaceId: "ws_alpha",
      planId: "free",
      customerId: "cus_1",
      subscriptionId: "sub_1",
    },
    store.query,
  );
  assert.deepEqual(store.calls[0].params, ["ws_alpha", "free", "cus_1", "sub_1"]);
  // A later event carrying fewer ids must not erase the ones we already know.
  assert.match(store.calls[0].sql, /coalesce\(EXCLUDED\.polar_customer_id/);

  const ignored: WebhookEvent[] = [
    { consumed: "none", type: "subscription.past_due" },
    { consumed: "none", type: "order.paid" },
    {
      consumed: "checkout",
      type: "checkout.updated",
      checkoutId: "chk_open",
      workspaceId: "ws_alpha",
      succeeded: false,
    },
  ];
  for (const event of ignored) await applyWebhook(event, store.query);
  assert.equal(store.calls.length, 1, "nothing else touched a row");
});

test("the webhook route refuses in mock mode, where there is nothing to reconcile", async () => {
  // This process is mock mode (no OBSTACK_DATA_MODE set), which is the
  // prototype deployment's shape: no Postgres, no plans, nothing a delivery
  // could be about. The tripwire is asserted because a silent one is not one.
  const route = await import("@/app/api/billing/webhook/route");
  const body = JSON.stringify({ type: "order.paid", data: {} });

  const { result: response, logged } = await capturingErrors(() =>
    route.POST(
      new Request("https://obstack.dev/api/billing/webhook", {
        method: "POST",
        body,
        headers: { [FAKE_SIGNATURE_HEADER]: signFakeWebhook(body) },
      }),
    ),
  );

  assert.equal(response.status, 404);
  assert.match(logged[0] ?? "", /\[billing\] webhook posted in mock mode/);
});
