import "server-only";
import { fakeBilling } from "./fake";
import { createPolarBilling } from "./polar";
import type { BillingClient, BillingMode, PolarMode } from "./types";

/**
 * Which implementation the process talks to. Everything the product does with
 * money goes through `getBilling()` and `reconcile.ts` — re-exported from
 * `index.ts`, which is the only path the rest of the app imports — and nothing
 * outside this directory imports `@polar-sh/sdk`. That is the D110 module
 * boundary, and it is what keeps "which billing rail are we on?" a one-line
 * answer.
 *
 * `OBSTACK_BILLING_MODE` selects the implementation and DEFAULTS TO `fake`
 * (D168). Consequences worth stating, because they are the reason the default
 * is that way round:
 *
 *  - CI sets nothing, so CI runs the fake, so no Polar secret has ever entered
 *    GitHub Actions.
 *  - A deployment that means to bill has to say so, and either Polar mode
 *    without `POLAR_ACCESS_TOKEN` refuses loudly at first use instead of
 *    silently falling back to the fake — a fallback there would mean taking a
 *    plan change nobody was ever charged for.
 *  - `polar-sandbox` and `polar` are the same code against Polar's sandbox and
 *    production environments (D338). A production deployment runs `polar` and
 *    never either of the other two (D344).
 */
export function billingMode(): BillingMode {
  const raw = process.env.OBSTACK_BILLING_MODE ?? "fake";
  if (raw !== "fake" && raw !== "polar-sandbox" && raw !== "polar") {
    throw new Error(
      `OBSTACK_BILLING_MODE must be "fake", "polar-sandbox" or "polar", got "${raw}"`,
    );
  }
  return raw;
}

/**
 * Does this mode talk to Polar? The single answer to that question (D338), so
 * no caller asks it by naming one rail and silently excluding the other — which
 * is exactly how a production deployment would end up not metering.
 */
export function isPolar(mode: BillingMode): mode is PolarMode {
  return mode !== "fake";
}

/**
 * Build one. Exported beside `getBilling` so the mode seam itself can be tested
 * — including the refusal, which is a property about the Polar modes and cannot
 * be proven through a cached process-wide instance. The mode is handed on:
 * which Polar environment the client talks to is this one value and no second
 * switch.
 */
export function createBillingClient(mode: BillingMode): BillingClient {
  return isPolar(mode) ? createPolarBilling(mode) : fakeBilling;
}

let client: BillingClient | undefined;

/** The one instance, built on first use (D114: fake mode boots with no Polar env at all). */
export function getBilling(): BillingClient {
  if (!client) client = createBillingClient(billingMode());
  return client;
}

