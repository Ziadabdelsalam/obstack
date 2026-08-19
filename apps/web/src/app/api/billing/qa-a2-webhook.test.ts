import assert from "node:assert/strict";
import test from "node:test";
// Reach the two writes THROUGH `reconcile` directly, not the `@/server/billing`
// barrel: the barrel re-exports `reporter.ts`, which statically imports
// `@/server/data`, and `dataMode` is a module-level const resolved ONCE at first
// import. A static barrel import here would freeze it to the default `mock`
// before the env below runs (static imports are hoisted above module-body
// statements), and the route's B2-4 delivery would then 404 in mock mode
// instead of exercising the live rejection path. This is the same reason
// `webhook-route.test.ts` imports only from `./fake` and dynamic-imports the
// route (D156, per-file process isolation).
import { applyWebhook } from "@/server/billing/reconcile";
import { FAKE_SIGNATURE_HEADER, signFakeWebhook } from "@/server/billing/fake";
import { normalizeWebhook } from "@/server/billing/webhook";

// run with: npm test --workspace apps/web
// DESTINATION: apps/web/src/app/api/billing/qa-a2-webhook.test.ts
//
// S3.3 QA area A2 — the webhook route under hostile delivery. Live mode, fake
// rail, no Postgres: the two repros below never reach a write that needs one.
process.env.OBSTACK_DATA_MODE = "live";
process.env.CLICKHOUSE_URL ??= "http://clickhouse.invalid:8123";
delete process.env.OBSTACK_BILLING_MODE;

const WS = "ws_qa_a2_alice";

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

/** One delivery, byte-identical every time it is sent — which is the point. */
const delivery = (type: string) =>
  JSON.stringify({
    type,
    data: { id: "sub_qa_a2", customerId: `cus_${WS}`, customer: { externalId: WS } },
  });

const post = async (body: string, headers: Record<string, string>): Promise<Response> => {
  const route = await import("@/app/api/billing/webhook/route");
  return route.POST(
    new Request("https://obstack.dev/api/billing/webhook", { method: "POST", body, headers }),
  );
};

/**
 * B2-2 — S2 — a REPLAYED lifecycle delivery resurrects a revoked plan.
 *
 * Driven against the running product first (production build, live mode, fake
 * rail): `subscription.active` → `pro`, `subscription.revoked` → `free`, then
 * the BYTE-IDENTICAL `subscription.active` body re-posted with its original
 * signature → 200 and `workspace_plans.plan_id` back to `pro`.
 *
 * Nothing on this path is ordered or deduplicated: there is no event id, no
 * delivery id, no timestamp and no state machine — `applyWebhook` writes
 * whatever the last delivery said. Polar retries an unACKed delivery ten times
 * with backoff (the route's own note), so a retry that lands after the
 * revocation it preceded silently re-grants entitlement, with no attacker
 * needed at all.
 */
test("B2-2: a replayed subscription.active does not undo the revocation that followed it", async () => {
  const { writes, query } = planWrites();
  const active = normalizeWebhook(JSON.parse(delivery("subscription.active")));
  const revoked = normalizeWebhook(JSON.parse(delivery("subscription.revoked")));

  await applyWebhook(active, query);
  assert.deepEqual(writes.at(-1), { workspaceId: WS, planId: "pro" }, "precondition: active ⇒ pro");

  await applyWebhook(revoked, query);
  assert.deepEqual(
    writes.at(-1),
    { workspaceId: WS, planId: "free" },
    "precondition: revoked ⇒ free (D169, revocation is the cutoff)",
  );

  // The same delivery Polar already made, made again — a retry, or a captured
  // body re-posted. It must not move a workspace that has since been revoked.
  await applyWebhook(active, query);

  assert.deepEqual(
    writes.at(-1),
    { workspaceId: WS, planId: "free" },
    "a re-delivered event already superseded by a revocation must not write pro again",
  );
});

/**
 * B2-4 — S3 — the webhook rejection log echoes the caller's raw body bytes.
 *
 * The route's own contract: "The message names the failure, never the body and
 * never a secret." It reports `error.message`, and in fake mode a body that
 * passes the HMAC but is not JSON reaches `JSON.parse`, whose V8 message quotes
 * up to twelve bytes of the body VERBATIM — newlines included.
 *
 * Observed in the running server's log, two physical lines from one call:
 *
 *   [billing] webhook rejected: Unexpected token 'b', "
 *   [billing] c"... is not valid JSON
 *
 * The second line carries the product's own `[billing] ` prefix, so an operator
 * reading the log sees a line obstack never emitted. (Reachable unauthenticated
 * in fake mode, whose signing secret is a checked-in constant by D168; in
 * sandbox mode it needs the webhook secret, but the contract is the route's
 * either way.)
 */
test("B2-4: a rejected webhook logs the failure, never the caller's body bytes", async () => {
  const body = '\n[billing] c" forged\nX';

  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  let response: Response;
  try {
    response = await post(body, { [FAKE_SIGNATURE_HEADER]: signFakeWebhook(body) });
  } finally {
    console.error = realError;
  }

  assert.equal(response.status, 403);
  assert.equal(await response.text(), "", "the sender still learns nothing");

  const line = logged.join("\n");
  assert.doesNotMatch(
    line,
    /[\n\r\u2028\u2029]/,
    "a rejection line must stay ONE line — a caller's newline must not split it",
  );
  assert.ok(
    !line.includes("[billing] c"),
    "the rejection message must not quote the caller's body back into our log",
  );
});
