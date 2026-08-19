import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeWebhook } from "./webhook";
import {
  CHECKOUT_RETURN_PARAM,
  UnknownCheckout,
  type BillingClient,
  type CheckoutRequest,
  type CheckoutState,
  type CreatedCheckout,
  type SubscriptionState,
  type UsageEvent,
  type UsageIngestResult,
  type WebhookEvent,
} from "./types";

/**
 * The default implementation through M3 (D168) and the only one CI ever runs.
 * It is not a stub: it is the billing rail with the third party removed, so
 * every path the product takes in production is a path the tests and the e2e
 * drive take here — a checkout is created, the browser returns to OUR return
 * path with a real id, `reconcileCheckout` reads it back and writes the plan
 * row, and a webhook is signed, verified and dispatched through the same
 * `normalizeWebhook` the sandbox client uses.
 *
 * Two behaviours are honest rather than convenient, because a test that leans
 * on them is otherwise proving nothing:
 *
 *  - `ingestUsage` really deduplicates on `externalId` and really reports the
 *    duplicate count, so T9's "re-sending a closed window is free" is a proof
 *    about our idempotency and not about a Map that swallows everything (D168).
 *  - `getCheckout` throws `UnknownCheckout` for an id it never issued, exactly
 *    as Polar answers 404 — so the return path's handling of a stale or hostile
 *    `?checkout=` parameter is exercised here and not discovered in sandbox.
 *  - `getCheckout` answers NO subscription id, because the measured rail does
 *    not (D194). The generous version of that field was the shape a drive could
 *    assert and production could never satisfy.
 *
 * What it does NOT model: payment. A fake checkout succeeds at creation, which
 * is the ruled semantics — the thing under test is our reconciliation, and a
 * card form is Polar's.
 */

/**
 * The fake's signing secret, a constant on purpose: it is checked in, it is not
 * a credential, and it lets the e2e drive sign a webhook without provisioning
 * anything. `polar-sandbox` uses `POLAR_WEBHOOK_SECRET` from the environment
 * and this value has no meaning there.
 */
export const FAKE_WEBHOOK_SECRET = "obstack-fake-webhook-secret";

/** The fake's header, named here so the drive and the tests sign the same way. */
export const FAKE_SIGNATURE_HEADER = "x-obstack-signature";

/** Hex HMAC-SHA256 over the exact raw body — the fake's whole signature scheme. */
export function signFakeWebhook(rawBody: string, secret: string = FAKE_WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * In-memory and process-lifetime, which is the same lifetime the fake's
 * usefulness has. One Next server is one process, so a checkout created by the
 * action is readable by the return path in the same server.
 */
const checkouts = new Map<string, CheckoutState>();

/**
 * The customer's present subscription, keyed by workspace — the rail's state
 * that convergence reads (D194/D195). SETTABLE on purpose: a webhook is a
 * doorbell that re-reads this, so a revoke-then-redeliver sequence is only
 * drivable if a test can move this the way Polar would. A workspace absent from
 * the map has no subscription, which yields `free` — exactly Polar's answer for
 * a customer it never subscribed.
 */
const subscriptions = new Map<string, SubscriptionState>();

/**
 * Drive the fake's rail state the way Polar's own lifecycle would: an active
 * upgrade sets an entitled subscription, a `null` clears it (the revocation
 * that returns a workspace to free). The e2e drive and the reconciliation tests
 * reach for this to stage the sequences a real Polar account would go through.
 */
export function setFakeSubscription(workspaceId: string, state: SubscriptionState | null): void {
  if (state) subscriptions.set(workspaceId, state);
  else subscriptions.delete(workspaceId);
}

/** Polar's server-side dedup, modelled by the one thing it is: a set of ids. */
const ingestedEventIds = new Set<string>();

const fakeId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;

/** Constant-time, and length-safe: `timingSafeEqual` throws on a length mismatch. */
function signatureMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const fakeBilling: BillingClient = {
  mode: "fake",

  async createCheckout(request: CheckoutRequest): Promise<CreatedCheckout> {
    const checkoutId = fakeId("chk");
    // The checkout carries only the trigger and its owner (D195): a paid session
    // for this workspace. It names no plan and no ids — the plan comes from the
    // subscription, not from the checkout object.
    checkouts.set(checkoutId, { status: "succeeded", externalCustomerId: request.workspaceId });
    // A completed fake checkout means Polar created the subscription: the rail's
    // present state for this workspace is now an entitled subscription, which is
    // what `getSubscriptionState` will answer and convergence will write as pro.
    // The subscription id lives HERE and only here (D194): the checkout never
    // carries one, so CI and the drive cannot assert a value production yields
    // only on the subscription.
    subscriptions.set(request.workspaceId, {
      active: true,
      customerId: `cus_${request.workspaceId}`,
      subscriptionId: fakeId("sub"),
    });
    const separator = request.returnPath.includes("?") ? "&" : "?";
    return {
      checkoutId,
      url: `${request.returnPath}${separator}${CHECKOUT_RETURN_PARAM}=${checkoutId}`,
    };
  },

  async getCheckout(checkoutId: string): Promise<CheckoutState> {
    const state = checkouts.get(checkoutId);
    if (!state) throw new UnknownCheckout(checkoutId);
    return state;
  },

  async getSubscriptionState(workspaceId: string): Promise<SubscriptionState> {
    return subscriptions.get(workspaceId) ?? { active: false, customerId: null, subscriptionId: null };
  },

  async ingestUsage(events: UsageEvent[]): Promise<UsageIngestResult> {
    let inserted = 0;
    let duplicates = 0;
    for (const event of events) {
      if (ingestedEventIds.has(event.externalId)) duplicates += 1;
      else {
        ingestedEventIds.add(event.externalId);
        inserted += 1;
      }
    }
    return { inserted, duplicates };
  },

  verifyWebhook(rawBody: string, headers: Record<string, string>): WebhookEvent {
    const given = headers[FAKE_SIGNATURE_HEADER] ?? headers[FAKE_SIGNATURE_HEADER.toUpperCase()];
    if (!given || !signatureMatches(signFakeWebhook(rawBody), given)) {
      throw new Error("fake webhook signature does not match");
    }
    // Parsed only AFTER the signature holds — the same order the real path
    // keeps, and the reason the route reads the raw body itself (D169). A body
    // that clears the HMAC but is not JSON throws here, and V8's SyntaxError
    // quotes up to twelve bytes of the body VERBATIM (newlines included) into
    // its message. The route logs a verifier's message, so an unquoted body
    // would forge a `[billing] ` line in our log — the B2-4 leak. The message
    // is replaced with a fixed one that names the failure and no caller bytes.
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new Error("fake webhook body is not valid JSON");
    }
    return normalizeWebhook(payload);
  },
};
