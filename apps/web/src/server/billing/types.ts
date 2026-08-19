import "server-only";

/**
 * The billing contract, stated once (D168). Everything below is the shape both
 * implementations answer in — `polar.ts` against Polar's sandbox, `fake.ts`
 * against a Map — so nothing outside this directory ever learns what a Polar
 * object looks like, and no second copy of "what a checkout is" exists.
 *
 * The rest of the product reaches billing through `index.ts` (`getBilling()`),
 * and through `reconcile.ts` for the two writes. Ingest never appears here at
 * all: the Go service meters into our own Postgres ledger and never calls Polar
 * (D110), so nothing on this page is on a hot path.
 */

/**
 * Which implementation answers. `fake` is the default through M3 and the only
 * one CI ever runs — no Polar secret enters GitHub Actions this milestone
 * (D168). `polar-sandbox` is the sandbox rail; the production flip is the
 * registered S5-GATE and nothing in this module promotes it.
 */
export type BillingMode = "fake" | "polar-sandbox";

/**
 * The plan ids the billing rail names, and the ONLY plan facts that live in
 * TypeScript. Everything a plan IS — quota, retention, price — is a row in
 * `plans` (D163), read through `server/usage.ts`; these two are keys into that
 * table, needed here because D169 rules the subscription webhooks to a plan by
 * name rather than by a product lookup.
 */
export const PLAN_FREE = "free";
export const PLAN_PRO = "pro";

/**
 * The query parameter a returning checkout carries. Exported because the
 * settings page reads it and `createCheckout` writes it — one definition of the
 * return contract, so a rename cannot leave the reader looking for the old name.
 */
export const CHECKOUT_RETURN_PARAM = "checkout";

/** What a plan change asks for. The workspace is the caller's session, never a form field (D148). */
export interface CheckoutRequest {
  workspaceId: string;
  planId: string;
  /** An app-relative path — where the customer lands afterwards, carrying `?checkout=<id>`. */
  returnPath: string;
}

/** What creating one answers with: where to send the browser, and the id to reconcile by. */
export interface CreatedCheckout {
  url: string;
  checkoutId: string;
}

/**
 * A checkout as we read it back. Polar's five states collapse to three because
 * three is all the product does anything with: still going, paid, over.
 *
 * `externalCustomerId` is the workspace the checkout was created for, and it is
 * on this interface for one reason: the checkout id arrives on the return path
 * as a URL parameter, so it is caller-supplied. Without the workspace to compare
 * it against, pasting someone else's succeeded checkout id would write THEIR
 * plan onto YOUR workspace — `reconcileCheckout` refuses exactly that (D148).
 */
export interface CheckoutState {
  status: "open" | "succeeded" | "expired";
  externalCustomerId?: string;
  customerId?: string;
  subscriptionId?: string;
  planId?: string;
}

/**
 * A checkout id that names nothing — Polar answers 404, the fake throws the
 * same class. Its own type so `reconcileCheckout` can tell "that id is not a
 * checkout" (a stale link or a hostile parameter, and nothing to do) apart from
 * "Polar is down", which must never be quietly reported as an expired session.
 */
export class UnknownCheckout extends Error {
  constructor(checkoutId: string, options?: { cause?: unknown }) {
    super(`no checkout ${JSON.stringify(checkoutId)}`, options);
    this.name = "UnknownCheckout";
  }
}

/**
 * One metered fact, as the reporter sends it (D170). `externalId` is the
 * deduplication key Polar honours server-side — a deterministic id per
 * (workspace, window) is what makes re-sending a closed window free, which is
 * why this module has no send-log and no watermark.
 */
export interface UsageEvent {
  externalCustomerId: string;
  externalId: string;
  name: string;
  timestamp: Date;
  metadata: Record<string, string | number | boolean>;
}

/** Polar's own answer: what landed, and what it had already seen. */
export interface UsageIngestResult {
  inserted: number;
  duplicates: number;
}

/**
 * A validated webhook, normalised to what D169 says we DO about it. The Polar
 * payload shapes stop here: the route switches on `consumed`, so the consumed
 * set is a fact about this type rather than a chain of field reads spread
 * across a handler.
 *
 * `none` is the majority and is not a failure — a valid event we have no work
 * for still gets a 200, because an unACKed delivery costs ten retries.
 */
export type WebhookEvent =
  | {
      consumed: "checkout";
      type: string;
      checkoutId: string;
      workspaceId: string;
      succeeded: boolean;
    }
  | {
      consumed: "plan";
      type: string;
      workspaceId: string;
      planId: string;
      customerId: string | null;
      subscriptionId: string;
    }
  | { consumed: "none"; type: string };

/**
 * The four calls, and the whole of what billing can do. `verifyWebhook` is
 * synchronous because both implementations verify in-process — the real one
 * through the SDK's `validateEvent`, the fake through an HMAC — and it THROWS on
 * a bad signature rather than returning a verdict, so a caller cannot forget to
 * check one.
 */
export interface BillingClient {
  readonly mode: BillingMode;
  createCheckout(request: CheckoutRequest): Promise<CreatedCheckout>;
  getCheckout(checkoutId: string): Promise<CheckoutState>;
  ingestUsage(events: UsageEvent[]): Promise<UsageIngestResult>;
  verifyWebhook(rawBody: string, headers: Record<string, string>): WebhookEvent;
}
