import "server-only";

/**
 * The one import path the rest of the product uses: `@/server/billing`. The
 * files behind it — the two implementations, the mode selector, the webhook
 * normaliser, the two writes and the usage reporter — are this directory's
 * business, and a caller that reached past this barrel would be a second place
 * that knows what Polar looks like (D110).
 *
 * `startUsageReporter` is exported for `instrumentation.ts` (D184): starting the
 * reporter is process wiring, but the process still has no business naming a
 * file inside the module — the boundary is the boundary for everyone, and the
 * only import outside this directory is this one path.
 */
export { billingMode, createBillingClient, getBilling } from "./client";
export { applyWebhook, reconcileCheckout, setWorkspacePlan } from "./reconcile";
export type { ReconcileResult } from "./reconcile";
export { startUsageReporter } from "./reporter";
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
