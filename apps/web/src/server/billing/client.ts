import "server-only";
import { fakeBilling } from "./fake";
import { createPolarBilling } from "./polar";
import type { BillingClient, BillingMode } from "./types";

/**
 * Which implementation the process talks to. Everything the product does with
 * money goes through `getBilling()` and `reconcile.ts` — re-exported from
 * `index.ts`, which is the only path the rest of the app imports — and nothing
 * outside this directory imports `@polar-sh/sdk`. That is the D110 module
 * boundary, and it is what keeps "which billing rail are we on?" a one-line
 * answer.
 *
 * `OBSTACK_BILLING_MODE` selects the implementation and DEFAULTS TO `fake`
 * through M3 (D168). Consequences worth stating, because they are the reason
 * the default is that way round:
 *
 *  - CI sets nothing, so CI runs the fake, so no Polar secret has ever entered
 *    GitHub Actions this milestone.
 *  - A deployment that means to bill has to say so, and `polar-sandbox` without
 *    `POLAR_ACCESS_TOKEN` refuses loudly at first use instead of silently
 *    falling back to the fake — a fallback there would mean taking a plan
 *    change nobody was ever charged for.
 *  - `polar-sandbox` is the only Polar value in M3. Production is the
 *    registered S5-GATE.
 */
export function billingMode(): BillingMode {
  const raw = process.env.OBSTACK_BILLING_MODE ?? "fake";
  if (raw !== "fake" && raw !== "polar-sandbox") {
    throw new Error(`OBSTACK_BILLING_MODE must be "fake" or "polar-sandbox", got "${raw}"`);
  }
  return raw;
}

/**
 * Build one. Exported beside `getBilling` so the mode seam itself can be tested
 * — including the refusal, which is a property about `polar-sandbox` and cannot
 * be proven through a cached process-wide instance.
 */
export function createBillingClient(mode: BillingMode): BillingClient {
  return mode === "fake" ? fakeBilling : createPolarBilling();
}

let client: BillingClient | undefined;

/** The one instance, built on first use (D114: fake mode boots with no Polar env at all). */
export function getBilling(): BillingClient {
  if (!client) client = createBillingClient(billingMode());
  return client;
}

