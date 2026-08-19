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
    checkouts.set(checkoutId, {
      status: "succeeded",
      externalCustomerId: request.workspaceId,
      customerId: `cus_${request.workspaceId}`,
      subscriptionId: fakeId("sub"),
      planId: request.planId,
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
    // keeps, and the reason the route reads the raw body itself (D169).
    return normalizeWebhook(JSON.parse(rawBody));
  },
};
