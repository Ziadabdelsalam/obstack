import "server-only";
import { PLAN_FREE, PLAN_PRO, type WebhookEvent } from "./types";

/**
 * D169's consumed set, as one table and one total function. Both
 * implementations verify a signature and then hand the payload here, so the
 * question "what does obstack do with a `subscription.past_due`?" has exactly
 * one answer and it is readable in one place.
 *
 * The rule that shapes everything below: a signature we accepted is a delivery
 * we ACK. An event we have no work for is `none` and gets a 200 — not a 4xx,
 * because Polar retries an unACKed delivery ten times with backoff, and there
 * is nothing to retry.
 *
 * Total over hostile input by construction (D68): the payload arrives as parsed
 * JSON of a shape we did not author, so every field read below is guarded and
 * anything unrecognised falls through to `none`. Nothing here trusts the body
 * for authorization either — the workspace comes from Polar's
 * `external_customer_id`, which only Polar can set, and which we set to the
 * workspace id when the customer was created (D110).
 */

/** A subscription in any of these states means the workspace is on `pro`. */
const SUBSCRIPTION_ACTIVE = new Set([
  "subscription.created",
  "subscription.updated",
  "subscription.active",
  "subscription.uncanceled",
]);

/**
 * And these two put it back on `free`. `subscription.past_due` is deliberately
 * in NEITHER set: Polar is the merchant of record and owns dunning, so a past-due
 * subscription keeps its entitlements and the revocation that follows — if it
 * follows — is the cutoff (D169).
 */
const SUBSCRIPTION_ENDED = new Set(["subscription.canceled", "subscription.revoked"]);

/** A field read that survives any shape, including `null` prototypes and arrays. */
function field(source: unknown, name: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  return (source as Record<string, unknown>)[name];
}

const stringField = (source: unknown, name: string): string | null => {
  const value = field(source, name);
  return typeof value === "string" && value ? value : null;
};

/**
 * The validated payload → what we do about it. Callers pass whatever their
 * verifier returned; the SDK's `validateEvent` and the fake's HMAC path produce
 * the same two fields (`type`, `data`), which is the only overlap this needs.
 */
export function normalizeWebhook(payload: unknown): WebhookEvent {
  const type = stringField(payload, "type") ?? "";
  const data = field(payload, "data");

  if (type === "checkout.updated") {
    const checkoutId = stringField(data, "id");
    const workspaceId = stringField(data, "externalCustomerId");
    // A checkout with no external customer is not one of ours — there is no
    // workspace to write a plan onto, so it is an ACK and nothing else.
    if (checkoutId && workspaceId) {
      return {
        consumed: "checkout",
        type,
        checkoutId,
        workspaceId,
        succeeded: stringField(data, "status") === "succeeded",
      };
    }
    return { consumed: "none", type };
  }

  const active = SUBSCRIPTION_ACTIVE.has(type);
  if (active || SUBSCRIPTION_ENDED.has(type)) {
    const subscriptionId = stringField(data, "id");
    const workspaceId = stringField(field(data, "customer"), "externalId");
    if (subscriptionId && workspaceId) {
      return {
        consumed: "plan",
        type,
        workspaceId,
        planId: active ? PLAN_PRO : PLAN_FREE,
        customerId: stringField(data, "customerId"),
        subscriptionId,
      };
    }
    return { consumed: "none", type };
  }

  return { consumed: "none", type };
}
