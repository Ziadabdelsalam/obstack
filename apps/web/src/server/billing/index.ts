import "server-only";

/**
 * The one import path the rest of the product uses: `@/server/billing`. The
 * files behind it — the two implementations, the mode selector, the webhook
 * normaliser and the two writes — are this directory's business, and a caller
 * that reached past this barrel would be a second place that knows what Polar
 * looks like (D110).
 */
export { billingMode, createBillingClient, getBilling } from "./client";
export { applyWebhook, reconcileCheckout, setWorkspacePlan } from "./reconcile";
export type { ReconcileResult } from "./reconcile";
export { CHECKOUT_RETURN_PARAM, PLAN_FREE, PLAN_PRO, UnknownCheckout } from "./types";
export type {
  BillingClient,
  BillingMode,
  CheckoutRequest,
  CheckoutState,
  CreatedCheckout,
  UsageEvent,
  UsageIngestResult,
  WebhookEvent,
} from "./types";
