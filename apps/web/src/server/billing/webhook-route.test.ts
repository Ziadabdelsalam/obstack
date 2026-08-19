import assert from "node:assert/strict";
import test from "node:test";
import { signFakeWebhook, FAKE_SIGNATURE_HEADER } from "./fake";

// run with: npm test --workspace apps/web
//
// The route's own two answers — 403 for a signature that does not hold, 200 for
// a valid delivery — in a LIVE-mode process, which is the only mode the route
// does anything in. Its own file because `dataMode` is resolved once per
// process from the environment: the mock-mode refusal is asserted in
// `billing.test.ts`, and `node --test` isolates per file (D156), so the two
// modes can both be real here without either shimming the other.
//
// No Polar, billing mode defaults to the fake. The 403 answers and the no-work
// ACK need no row and no connection. The one delivery that reaches convergence —
// a succeeded checkout — now runs inside a transaction (D195, the advisory lock
// holds across the rail read and write), so it dials the compose Postgres; an
// unset test DSN skips that one, like qa-a4.
process.env.OBSTACK_DATA_MODE = "live";
process.env.CLICKHOUSE_URL ??= "http://clickhouse.invalid:8123";
process.env.OBSTACK_POSTGRES_DSN ??= process.env.OBSTACK_TEST_POSTGRES_DSN;
delete process.env.OBSTACK_BILLING_MODE;

const skipNoPg = process.env.OBSTACK_TEST_POSTGRES_DSN
  ? undefined
  : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";

const post = async (body: string, headers: Record<string, string>): Promise<Response> => {
  const route = await import("@/app/api/billing/webhook/route");
  return route.POST(
    new Request("https://obstack.dev/api/billing/webhook", { method: "POST", body, headers }),
  );
};

test("a delivery whose signature does not hold gets a bare 403 (D169)", async () => {
  const body = JSON.stringify({ type: "order.paid", data: {} });

  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  let forged: Response;
  try {
    forged = await post(body, { [FAKE_SIGNATURE_HEADER]: signFakeWebhook(body, "wrong") });
  } finally {
    console.error = real;
  }
  assert.equal(forged.status, 403);
  assert.equal(await forged.text(), "", "no body detail — nothing to learn from the refusal");
  // Silent to the sender, logged for us: a refusal nobody can see is how a
  // missing `POLAR_WEBHOOK_SECRET` reads as an attacker for a week.
  assert.match(logged[0] ?? "", /\[billing\] webhook rejected/);

  const unsigned = await post(body, {});
  assert.equal(unsigned.status, 403);

  // Signed, then edited: the signature covers the exact bytes, which is why the
  // handler reads the raw body and lets nothing parse it first.
  const tampered = await post(`${body} `, { [FAKE_SIGNATURE_HEADER]: signFakeWebhook(body) });
  assert.equal(tampered.status, 403);
});

test("a valid delivery we have no work for is ACKed, not refused (D169)", async () => {
  // An unACKed event costs ten retries with backoff, so the majority of the
  // event enum — everything outside the consumed set — has to answer 200.
  for (const type of ["order.paid", "subscription.past_due", "customer.created"]) {
    const body = JSON.stringify({ type, data: { id: "x", customer: { externalId: "ws_alpha" } } });
    const response = await post(body, { [FAKE_SIGNATURE_HEADER]: signFakeWebhook(body) });
    assert.equal(response.status, 200, type);
  }
});

test(
  "a consumed checkout event naming an id the rail never issued still ACKs",
  { skip: skipNoPg },
  async () => {
    // The convergence is the same one the return path runs, so an id that
    // resolves to nothing is nothing to do — and a 200, because retrying it
    // would resolve to nothing ten more times. It runs inside the transaction
    // the route opens for a consumed event, which is why this one needs Postgres.
    const body = JSON.stringify({
      type: "checkout.updated",
      data: { id: "chk_never_issued", status: "succeeded", externalCustomerId: "ws_alpha" },
    });
    const response = await post(body, { [FAKE_SIGNATURE_HEADER]: signFakeWebhook(body) });
    assert.equal(response.status, 200);
  },
);
