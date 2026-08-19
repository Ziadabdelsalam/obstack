import "server-only";
import type { QueryRows } from "@/server/postgres";
import { getBilling } from "./client";
import { UnknownCheckout, type WebhookEvent } from "./types";

/**
 * The two writes billing is allowed to make, and the ONE definition of what a
 * finished checkout does to our Postgres (D168). Two callers reach
 * `reconcileCheckout` — the settings page when the customer comes back, and the
 * webhook route when Polar catches up asynchronously — and they reach the same
 * function, so "the plan row is right" is one property with one implementation
 * rather than a return path and a reconciler that can disagree.
 *
 * `queryRows` is INJECTED (the D113 pattern) rather than imported: it is what
 * lets the whole reconciliation be proven against a recorded statement with no
 * Postgres in the process, and it is what keeps this module free of an ambient
 * store. Every statement binds the workspace as `$1` and names `workspace_id`
 * in its text — the D11 posture, and the only authorization this path has.
 *
 * Polar is the billing rail, never the quota source (D110): nothing here writes
 * usage, reads a meter, or decides whether a workspace is over quota. It writes
 * one row saying which plan a workspace is on.
 */

/**
 * `coalesce` on both Polar ids so a later event carrying fewer of them cannot
 * erase what an earlier one established — a `subscription.canceled` moves the
 * plan back to free while the customer stays the customer they were (D169).
 */
const UPSERT_PLAN_SQL = `
  INSERT INTO workspace_plans (workspace_id, plan_id, polar_customer_id, polar_subscription_id)
       VALUES ($1, $2, $3, $4)
  ON CONFLICT (workspace_id) DO UPDATE
          SET plan_id = EXCLUDED.plan_id,
              polar_customer_id = coalesce(EXCLUDED.polar_customer_id, workspace_plans.polar_customer_id),
              polar_subscription_id = coalesce(EXCLUDED.polar_subscription_id, workspace_plans.polar_subscription_id),
              updated_at = now()`;

/**
 * What a reconciliation did. `applied` is the only thing a caller has to act
 * on; the reasons exist so that "nothing happened" is never mistaken for
 * "upgraded", which is the failure a boolean alone would hide on the return
 * path a customer is staring at.
 */
export type ReconcileResult =
  | { applied: true; planId: string }
  | { applied: false; reason: "pending" | "expired" | "unknown" | "refused" };

/** The plan row, as both callers write it. */
export async function setWorkspacePlan(
  workspaceId: string,
  planId: string,
  polarCustomerId: string | null,
  polarSubscriptionId: string | null,
  query: QueryRows,
): Promise<void> {
  await query(UPSERT_PLAN_SQL, [workspaceId, planId, polarCustomerId, polarSubscriptionId]);
}

/**
 * Read the checkout back from Polar and, if it is paid, write the plan row.
 *
 * The checkout id is CALLER-SUPPLIED — it arrives on the return path as a URL
 * parameter, so it is whatever someone put in the address bar. Two guards make
 * that safe, and both are refusals rather than errors:
 *
 *  - an id Polar does not know is `unknown`, not an exception a settings page
 *    turns into a 500 (the fake throws the same class Polar's 404 does, so this
 *    branch is exercised in tests);
 *  - a checkout belonging to a DIFFERENT workspace is `refused` and logged.
 *    Without that comparison, pasting a stranger's succeeded checkout id would
 *    write their plan onto your workspace — the checkout's own external
 *    customer is the owner pin (D148), and only Polar can set it.
 *
 * A succeeded checkout with no plan id in its metadata is also refused: there
 * is no plan to write and guessing one is how a free workspace becomes a paid
 * row nobody sold.
 */
export async function reconcileCheckout(
  checkoutId: string,
  workspaceId: string,
  query: QueryRows,
): Promise<ReconcileResult> {
  let state;
  try {
    state = await getBilling().getCheckout(checkoutId);
  } catch (error) {
    if (error instanceof UnknownCheckout) return { applied: false, reason: "unknown" };
    throw error;
  }

  if (state.status === "open") return { applied: false, reason: "pending" };
  if (state.status === "expired") return { applied: false, reason: "expired" };

  if (state.externalCustomerId && state.externalCustomerId !== workspaceId) {
    console.error(
      `[billing] checkout ${checkoutId} belongs to another workspace — not reconciled`,
    );
    return { applied: false, reason: "refused" };
  }
  if (!state.planId) {
    console.error(`[billing] checkout ${checkoutId} succeeded with no plan id — not reconciled`);
    return { applied: false, reason: "refused" };
  }

  await setWorkspacePlan(
    workspaceId,
    state.planId,
    state.customerId ?? null,
    state.subscriptionId ?? null,
    query,
  );
  return { applied: true, planId: state.planId };
}

/**
 * A validated webhook, applied. The D169 dispatch, whole: a checkout event goes
 * through the same reconciliation the return path uses, a subscription event
 * writes the plan the normaliser already decided, and everything else is an ACK
 * with no write. The UPSERT runs inline — one statement does not need a queue
 * (D169), and Polar's 10s timeout is not close.
 */
export async function applyWebhook(event: WebhookEvent, query: QueryRows): Promise<void> {
  if (event.consumed === "checkout") {
    if (event.succeeded) await reconcileCheckout(event.checkoutId, event.workspaceId, query);
    return;
  }
  if (event.consumed === "plan") {
    await setWorkspacePlan(
      event.workspaceId,
      event.planId,
      event.customerId,
      event.subscriptionId,
      query,
    );
  }
}
