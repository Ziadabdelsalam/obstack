"use server";

import { redirect } from "next/navigation";
import { getBilling } from "@/server/billing";
import { dataMode } from "@/server/data";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * The one thing the Billing & usage tab WRITES: a plan change, which is a
 * checkout session and a redirect to it. Its own module rather than a fifth
 * export in `actions.ts` because a `"use server"` module may export nothing but
 * server actions — the session gate below is duplicated for exactly that reason
 * and for no other, since exporting `settingsSession` from there would publish
 * it as a POST endpoint of its own.
 *
 * Authorization is the same shape the rest of settings keeps (D148): a Server
 * Function is reachable by a direct POST, so the workspace comes from the
 * session on the server and the client names a PLAN — never a tenant, never a
 * price, never a Polar id. What the plan means (quota, retention, price) is a
 * row in `plans` and is never restated here (D163), which is also how the plan
 * id gets validated: by existing in that table.
 *
 * No money is computed anywhere on this path. Polar is the merchant of record —
 * it owns the price, the tax and the invoice (D110), and this action's whole
 * job is to hand a workspace and a product to it and send the browser there.
 */

const SETTINGS_PATH = "/app/settings";

/**
 * The one failure exit, and a code already in `errors.ts`' vocabulary: a
 * checkout that could not be created has nothing the reader can do differently,
 * and a code for "Polar was unreachable" would put our outage in a customer's
 * face as though it were their input (D121 — the caller's text never reaches
 * the query string).
 */
const FAILED = `${SETTINGS_PATH}?error=settings-failed`;

/**
 * The gate, mode check FIRST — mock mode is the fictional-data prototype with
 * no accounts, no Postgres and no billing, so a post that reaches here came
 * from somewhere no visitor can be (D150/D152). The log line is the tripwire
 * and no error code is emitted, because the settings vocabulary answers a real
 * attempt and this is not one. Asserted, per action, in
 * `app/signup/mock-mode.test.ts`.
 */
async function billingSession(where: string) {
  if (dataMode === "mock") {
    console.error(`[settings] ${where} posted in mock mode — this deployment keeps no accounts`);
    redirect(SETTINGS_PATH);
  }
  const session = await getSessionContext();
  if (!session) redirect("/login");
  return session;
}

/** Does the catalog have this plan? The catalog is the definition (D163), so it decides. */
async function planExists(planId: string): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(`SELECT id FROM plans WHERE id = $1`, [planId]);
  return rows.length > 0;
}

/**
 * Start a plan change. The checkout is created against the caller's own
 * workspace and the customer is sent to it; nothing about the plan row changes
 * here. It changes when the customer comes BACK — the settings page reads the
 * checkout's real state through `reconcileCheckout` (D110's poll-on-return),
 * and the webhook route reconciles the same way if they never return.
 */
export async function startCheckout(formData: FormData): Promise<void> {
  const session = await billingSession("start checkout");

  const planId = String(formData.get("planId") ?? "");

  // One statement per `try`, and `redirect` reached only from a catch: it
  // signals by THROWING, so a redirect inside a try would be swallowed by that
  // try's own catch (`actions.ts` states the same rule).
  let known: boolean;
  try {
    known = await planExists(planId);
  } catch (error) {
    console.error("[settings] start checkout", error);
    redirect(FAILED);
  }
  if (!known) {
    // Not a plan we sell. The form offers only catalog rows, so this is a stale
    // tab or a direct post — the generic sentence is the right answer, and the
    // log names what was asked for.
    console.error(`[settings] start checkout named no plan of ours: ${JSON.stringify(planId)}`);
    redirect(FAILED);
  }

  let created;
  try {
    created = await getBilling().createCheckout({
      workspaceId: session.workspaceId,
      planId,
      returnPath: SETTINGS_PATH,
    });
  } catch (error) {
    console.error("[settings] start checkout", error);
    redirect(FAILED);
  }
  redirect(created.url);
}
