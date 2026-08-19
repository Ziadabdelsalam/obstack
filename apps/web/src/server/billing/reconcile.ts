import "server-only";
import { lockWorkspace, withTransaction, type QueryRows, type TxQuery } from "@/server/postgres";
import { getBilling } from "./client";
import { PLAN_FREE, PLAN_PRO, UnknownCheckout, type BillingClient, type WebhookEvent } from "./types";

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
 * The write is a CONVERGENCE, not an accumulation (D195): every column is set
 * to exactly what the present subscription state carries, ids included, with no
 * `coalesce`. A `free` convergence nulls both ids because the workspace has no
 * subscription to name — the whole point of reading the rail's present is that
 * the row ends up equal to it, so a revoked customer keeps no stale ids that a
 * later `active` bookmark could look like a match against.
 */
const UPSERT_PLAN_SQL = `
  INSERT INTO workspace_plans (workspace_id, plan_id, polar_customer_id, polar_subscription_id)
       VALUES ($1, $2, $3, $4)
  ON CONFLICT (workspace_id) DO UPDATE
          SET plan_id = EXCLUDED.plan_id,
              polar_customer_id = EXCLUDED.polar_customer_id,
              polar_subscription_id = EXCLUDED.polar_subscription_id,
              updated_at = now()`;

/**
 * What a reconciliation did, for the RETURN PATH to act on (the webhook ignores
 * it). `applied: true` means the upgrade the checkout was for is now live —
 * convergence landed on `pro`. Everything else is `applied: false`: a refused
 * trigger, or a succeeded checkout whose subscription has since lapsed and
 * converged to free. WHY a refusal happened is a log line at the refusal (D190),
 * where an operator can see it, rather than a union member no reader branches on.
 */
export type ReconcileResult = { applied: true; planId: string } | { applied: false };

/** The plan row, as convergence writes it. */
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
 * Converge a workspace's plan row onto the rail's PRESENT subscription state
 * (D195). This is the one write both triggers reach: read what the customer's
 * subscription is right now, and make the row equal it — active ⇒ `pro` with
 * the subscription's ids, nothing active ⇒ `free` with both ids nulled.
 *
 * Nothing is read from the trigger. A returning checkout id and a re-delivered
 * lifecycle event are DOORBELLS: they say "look again", and looking again reads
 * the present, so a spent bookmark or a retry that lands after a revocation
 * converges to free rather than replaying the grant that once was (B2-1/B2-2).
 *
 * The read→write is serialized on `lockWorkspace` so two concurrent syncs of
 * one workspace cannot interleave — the second to acquire the lock reads AFTER
 * the first committed, so the later present always wins and no stale grant
 * survives a revocation it raced. `query` is a `TxQuery`, so the transaction the
 * lock is scoped to is not a caller's promise but the type: the two doors are
 * the only sources of one and both hold a transaction open across this
 * read→write (D198), and a plain pooled `queryRows` — through which the lock
 * would release inside its own implicit transaction and serialize nothing — does
 * not typecheck here. The guard tests prove both doors against real Postgres.
 */
export async function syncPlanFromRail(
  workspaceId: string,
  query: TxQuery,
  billing: BillingClient = getBilling(),
): Promise<string> {
  await lockWorkspace(query, workspaceId);
  const subscription = await billing.getSubscriptionState(workspaceId);
  const planId = subscription.active ? PLAN_PRO : PLAN_FREE;
  await setWorkspacePlan(
    workspaceId,
    planId,
    subscription.active ? subscription.customerId : null,
    subscription.active ? subscription.subscriptionId : null,
    query,
  );
  return planId;
}

/**
 * Read the checkout back from the rail as the TRIGGER, verify its binding, then
 * converge (D195). The checkout is never the source of a plan — it is the proof
 * that a paid session for THIS workspace happened, and the doorbell that makes
 * `syncPlanFromRail` re-read the present subscription and write exactly that.
 *
 * The checkout id is CALLER-SUPPLIED — it arrives on the return path as a URL
 * parameter, so it is whatever someone put in the address bar. The binding
 * proofs run BEFORE any convergence and every one is a refusal, not an error,
 * that touches no row (the D176 zero-statement property):
 *
 *  - an id the rail does not know is nothing to do, not an exception a settings
 *    page turns into a 500 (the fake throws the same class Polar's 404 does, so
 *    this branch is exercised in tests);
 *  - a still-pending or expired checkout has no paid session to act on;
 *  - a checkout belonging to a DIFFERENT workspace is refused, and refused
 *    before the rail is read for a plan. Without that comparison, pasting a
 *    stranger's succeeded checkout id would drive a sync of your workspace off
 *    their session — the checkout's own external customer is the owner pin
 *    (D148), and only the rail can set it. That line is the security tripwire,
 *    and a tripwire nobody can read is not one, so a test asserts it.
 *
 * Every refusal logs its reason and exactly its reason (D168's refuse-loudly
 * posture, D190): the checkout id and why, never the body and never a
 * credential. The id is QUOTED and its ECMAScript line terminators escaped
 * (`\n`, `\r`, U+2028, U+2029), because it is caller-supplied and any of them
 * left raw forges a log line — including a forged copy of the tripwire.
 *
 * "Loud" means always emitted, not always `error` (D193). An id the rail never
 * issued and a foreign checkout cannot happen through honest use, so they are
 * errors; still-pending and expired are what the rail ordinarily answers when a
 * customer closes the tab, and pre-committing an alert level to a routine
 * outcome is how alerting becomes noise.
 *
 * `billing` is injected on the same D113 seam `query` is, and for the same
 * reason: the fake's checkout succeeds at creation, so the pending and expired
 * branches are only reachable — and therefore only PROVABLE — through a
 * stand-in rail. Both callers take the default.
 */
export async function reconcileCheckout(
  checkoutId: string,
  workspaceId: string,
  query: TxQuery,
  billing: BillingClient = getBilling(),
): Promise<ReconcileResult> {
  // Quoted once, for every line below, and its line terminators escaped:
  // `JSON.stringify` closes `\n`/`\r` but emits U+2028/U+2029 verbatim, and both
  // are ECMAScript line terminators that split a log line just as a newline does
  // (B2-3). See the note above about forged lines.
  const id = quoteId(checkoutId);

  let state;
  try {
    state = await billing.getCheckout(checkoutId);
  } catch (error) {
    if (error instanceof UnknownCheckout) {
      console.error(`[billing] checkout ${id} is unknown to the rail — not reconciled`);
      return { applied: false };
    }
    throw error;
  }

  if (state.status === "open") {
    console.warn(`[billing] checkout ${id} is still pending — not reconciled`);
    return { applied: false };
  }
  if (state.status === "expired") {
    console.warn(`[billing] checkout ${id} expired — not reconciled`);
    return { applied: false };
  }

  if (state.externalCustomerId && state.externalCustomerId !== workspaceId) {
    console.error(`[billing] checkout ${id} belongs to another workspace — not reconciled`);
    return { applied: false };
  }

  // The checkout is a paid session for this workspace — the trigger holds. What
  // plan the workspace is on is the subscription's present state, not this
  // object, so converge to it. `applied` is the RETURN PATH's answer and means
  // "the upgrade this checkout was for is now live": true only when convergence
  // landed on `pro`. A succeeded checkout whose subscription has since been
  // revoked converges to free and reports `applied: false` — the spent bookmark
  // gets the "unchanged" notice, not a false "upgraded" (B2-1).
  const planId = await syncPlanFromRail(workspaceId, query, billing);
  return planId === PLAN_PRO ? { applied: true, planId } : { applied: false };
}

/**
 * The RETURN PATH's door (D198). The settings page reconciles a returning
 * `?checkout=` here, and here is where the transaction the advisory lock is
 * scoped to is OWNED — the page has no `TxQuery` to hand in and cannot forge
 * one, so it calls this and this opens the transaction, which makes the return
 * path locked by construction exactly as the webhook path is by its route's
 * `withTransaction`. One transaction per reconcile: the `reconcileCheckout`
 * binding proofs and the `syncPlanFromRail` inside them share this one
 * connection and its lock, so no rail-read→plan-write on this path runs on a
 * pooled connection where the lock would be a no-op (the F6 return-path defect).
 */
export async function reconcileCheckoutReturn(
  checkoutId: string,
  workspaceId: string,
  billing: BillingClient = getBilling(),
): Promise<ReconcileResult> {
  return withTransaction((query) =>
    reconcileCheckout(checkoutId, workspaceId, query, billing),
  );
}

/**
 * `JSON.stringify` quotes and escapes `\n`/`\r`, but passes U+2028 LINE
 * SEPARATOR and U+2029 PARAGRAPH SEPARATOR through verbatim — both are
 * ECMAScript line terminators, so a JS log viewer, a JSON-lines splitter or a
 * `split` on a line-terminator class breaks on them exactly as on a newline
 * (B2-3). Escaping them closes the last two ways a caller-supplied id forges a
 * `[billing] ` line.
 */
function quoteId(checkoutId: string): string {
  return JSON.stringify(checkoutId)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * A validated webhook, applied — as a DOORBELL, never a data carrier (D195).
 * The D169 dispatch, whole: a succeeded checkout event and a subscription
 * lifecycle event BOTH mean "the rail changed, re-read it", so both converge
 * the plan to the present subscription state and neither is trusted for the
 * plan itself. Everything else is an ACK with no write. The convergence runs
 * inline — one read and one statement do not need a queue (D169), and Polar's
 * 10s timeout is not close.
 */
export async function applyWebhook(event: WebhookEvent, query: TxQuery): Promise<void> {
  // `query` is a `TxQuery`, so the convergence's `pg_advisory_xact_lock` is held
  // across its rail read and plan write (D198/D199). The webhook route is
  // applyWebhook's only caller and runs it INSIDE its own `withTransaction`
  // (route.ts) — the wrap IS the transaction, and the parameter type merely names
  // that fact, so the route hands in the branded client it already holds rather
  // than this function asserting one. A plain pooled `queryRows`, through which
  // the lock would serialize nothing, does not typecheck here, so the webhook
  // path's serialization no longer rests on caller convention (D199).
  if (event.consumed === "checkout") {
    if (event.succeeded) await reconcileCheckout(event.checkoutId, event.workspaceId, query);
    return;
  }
  if (event.consumed === "plan") {
    // The normaliser's plan/ids are the trigger's payload and are ignored: a
    // re-delivered or reordered `active` must not re-grant a subscription the
    // present has since revoked, so we read the present rather than apply the
    // event (B2-2).
    await syncPlanFromRail(event.workspaceId, query);
  }
}
