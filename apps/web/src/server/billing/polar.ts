import "server-only";
import { Polar } from "@polar-sh/sdk";
import { ResourceNotFound } from "@polar-sh/sdk/models/errors/resourcenotfound.js";
import { validateEvent } from "@polar-sh/sdk/webhooks.js";
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
  type PolarMode,
  type UsageIngestResult,
  type WebhookEvent,
} from "./types";

/**
 * The Polar rail — the ONLY module in the product that calls Polar (D110). One
 * implementation, two environments, chosen by the mode it is built with (D338):
 * `polar-sandbox` gives `server: "sandbox"`, which targets
 * `https://sandbox-api.polar.sh`, and `polar` gives `server: "production"`,
 * which targets `https://api.polar.sh`. Everything below is the same code on
 * both — the environments differ only in which Polar organisation, catalog and
 * money they are.
 *
 * Four environment values, none of them ever written to git, a log or CI:
 *
 *  - `POLAR_ACCESS_TOKEN` — an organization access token (`polar_oat_…`).
 *  - `POLAR_WEBHOOK_SECRET` — the endpoint secret, base64 per Standard Webhooks;
 *    it goes to `validateEvent` untouched, which is why the header names stay
 *    inside the SDK and no signature scheme is reimplemented here.
 *  - `OBSTACK_APP_URL` — our own origin, because Polar needs an ABSOLUTE success
 *    URL and this process has no request context when the reporter runs.
 *  - `POLAR_PRODUCT_<PLAN>` — the Polar product behind a plan id, e.g.
 *    `POLAR_PRODUCT_PRO`. The product lives in Polar's catalog, our plan lives
 *    in `plans` (D163), and this mapping is the seam between them; it is env
 *    rather than a column because the two sides of it differ per environment.
 *
 * The two Polar environments share no state: a sandbox product id or access
 * token means nothing in production and a production one means nothing in
 * sandbox (tokens are refused across the boundary, MEASURED), so every one of
 * the four values above is per-environment and switching the mode without
 * switching them is a configuration error, not a migration.
 *
 * Each is demanded at the moment it is needed and the failure names the missing
 * variable and nothing else — a message that echoed a token would put it in the
 * log the failure produces.
 */

/**
 * Missing configuration is loud, immediate, and never a fallback to the fake.
 * The message names the CONFIGURED mode, so an operator reads which rail asked
 * for the variable rather than a mode they are not running (D338).
 */
function requiring(mode: PolarMode) {
  return function required(name: string): string {
    const value = process.env[name];
    if (!value) {
      throw new Error(`${name} is required when OBSTACK_BILLING_MODE=${mode}`);
    }
    return value;
  };
}

/**
 * Polar's five checkout states, mapped onto the three the product acts on.
 * `confirmed` is payment in flight — it is not paid yet, so it reads as still
 * open and the return path polls again; `failed` is over without a plan change,
 * which is what `expired` means to us.
 */
function checkoutStatus(status: string): CheckoutState["status"] {
  if (status === "succeeded") return "succeeded";
  if (status === "expired" || status === "failed") return "expired";
  return "open";
}

/**
 * Polar's subscription statuses, reduced to the one bit convergence needs: is
 * this workspace entitled right now? `active` and `trialing` are live;
 * `past_due` KEEPS its entitlements because Polar is merchant of record and owns
 * dunning (D169), so the cutoff is the revocation that may follow, not the
 * dunning itself. Everything else — canceled, revoked, unpaid, incomplete,
 * paused — is over.
 */
const ENTITLED_STATUS = new Set(["active", "trialing", "past_due"]);

/**
 * Built once per process, on first use — not at module load, so a mock-mode or
 * fake-mode deployment that has no token still compiles and boots this file
 * (D114's rule, the same one `getPool` follows).
 */
export function createPolarBilling(mode: PolarMode): BillingClient {
  const required = requiring(mode);
  const client = new Polar({
    accessToken: required("POLAR_ACCESS_TOKEN"),
    server: mode === "polar" ? "production" : "sandbox",
  });

  return {
    mode,

    async createCheckout(request: CheckoutRequest): Promise<CreatedCheckout> {
      const product = required(`POLAR_PRODUCT_${request.planId.toUpperCase()}`);
      const appUrl = required("OBSTACK_APP_URL").replace(/\/+$/, "");
      const checkout = await client.checkouts.create({
        products: [product],
        // One Polar customer per workspace (D110): the external id IS the
        // workspace, so Polar creates or reuses the right customer with no
        // customer table of our own to keep in step.
        externalCustomerId: request.workspaceId,
        // `{CHECKOUT_ID}` is Polar's own interpolation, which is what lets the
        // return path carry the id under the same parameter the fake uses.
        successUrl: `${appUrl}${request.returnPath}?${CHECKOUT_RETURN_PARAM}={CHECKOUT_ID}`,
        metadata: { plan_id: request.planId, workspace_id: request.workspaceId },
      });
      return { checkoutId: checkout.id, url: checkout.url };
    },

    async getCheckout(checkoutId: string): Promise<CheckoutState> {
      let checkout;
      try {
        checkout = await client.checkouts.get({ id: checkoutId });
      } catch (error) {
        // 404 means the id names nothing — a stale link or a hostile parameter.
        // Anything else is an outage and must NOT read as a finished checkout.
        if (error instanceof ResourceNotFound) throw new UnknownCheckout(checkoutId, { cause: error });
        throw error;
      }
      return {
        status: checkoutStatus(String(checkout.status)),
        externalCustomerId: checkout.externalCustomerId ?? undefined,
      };
    },

    async getSubscriptionState(workspaceId: string): Promise<SubscriptionState> {
      // The customer's subscriptions, by the external id that IS the workspace
      // (D110). We converge to the FIRST entitled one — a workspace has one
      // subscription at a time on this product — and to `free` if none is, which
      // is also the answer for a customer the rail never subscribed. The list is
      // paged; the iterator walks pages, and we stop at the first entitled row.
      const pages = await client.subscriptions.list({ externalCustomerId: workspaceId });
      for await (const page of pages) {
        for (const subscription of page.result.items) {
          if (ENTITLED_STATUS.has(String(subscription.status))) {
            return {
              active: true,
              customerId: subscription.customerId ?? null,
              subscriptionId: subscription.id ?? null,
            };
          }
        }
      }
      return { active: false, customerId: null, subscriptionId: null };
    },

    async ingestUsage(events: UsageEvent[]): Promise<UsageIngestResult> {
      const response = await client.events.ingest({
        events: events.map((event) => ({
          externalCustomerId: event.externalCustomerId,
          externalId: event.externalId,
          name: event.name,
          timestamp: event.timestamp,
          metadata: event.metadata,
        })),
      });
      return { inserted: response.inserted, duplicates: response.duplicates };
    },

    verifyWebhook(rawBody: string, headers: Record<string, string>): WebhookEvent {
      // `validateEvent` throws `WebhookVerificationError` on a bad signature and
      // parses the body itself — the route hands it the RAW body precisely so
      // nothing has parsed it first (D169).
      return normalizeWebhook(validateEvent(rawBody, headers, required("POLAR_WEBHOOK_SECRET")));
    },
  };
}
