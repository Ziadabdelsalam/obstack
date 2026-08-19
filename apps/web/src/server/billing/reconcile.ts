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
 * What a reconciliation did. `applied` is the whole answer a caller acts on —
 * the return path turns it into one of two notices, the webhook ignores it —
 * and WHY nothing was applied is a log line at the refusal (D190), where an
 * operator reading a log can see it, rather than a union member no reader ever
 * branches on.
 */
export type ReconcileResult = { applied: true; planId: string } | { applied: false };

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
 *  - an id Polar does not know is nothing to do, not an exception a settings
 *    page turns into a 500 (the fake throws the same class Polar's 404 does, so
 *    this branch is exercised in tests);
 *  - a checkout belonging to a DIFFERENT workspace is refused. Without that
 *    comparison, pasting a stranger's succeeded checkout id would write their
 *    plan onto your workspace — the checkout's own external customer is the
 *    owner pin (D148), and only Polar can set it. That line is the security
 *    tripwire, and a tripwire nobody can read is not one, so a test asserts it.
 *
 * A succeeded checkout with no plan id in its metadata is also refused: there
 * is no plan to write and guessing one is how a free workspace becomes a paid
 * row nobody sold.
 *
 * Every one of the five ways this returns without writing logs its reason and
 * exactly its reason (D168's refuse-loudly posture, D190): the checkout id and
 * why, never the checkout body and never a credential. The id is QUOTED into
 * those lines, because it is caller-supplied and an unquoted newline in it
 * forges a log line — including a forged copy of the tripwire below.
 */
export async function reconcileCheckout(
  checkoutId: string,
  workspaceId: string,
  query: QueryRows,
): Promise<ReconcileResult> {
  // Quoted once, for every line below: see the note above about forged lines.
  const id = JSON.stringify(checkoutId);

  let state;
  try {
    state = await getBilling().getCheckout(checkoutId);
  } catch (error) {
    if (error instanceof UnknownCheckout) {
      console.error(`[billing] checkout ${id} is unknown to the rail — not reconciled`);
      return { applied: false };
    }
    throw error;
  }

  if (state.status === "open") {
    console.error(`[billing] checkout ${id} is still pending — not reconciled`);
    return { applied: false };
  }
  if (state.status === "expired") {
    console.error(`[billing] checkout ${id} expired — not reconciled`);
    return { applied: false };
  }

  if (state.externalCustomerId && state.externalCustomerId !== workspaceId) {
    console.error(`[billing] checkout ${id} belongs to another workspace — not reconciled`);
    return { applied: false };
  }
  if (!state.planId) {
    console.error(`[billing] checkout ${id} succeeded with no plan id — not reconciled`);
    return { applied: false };
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
