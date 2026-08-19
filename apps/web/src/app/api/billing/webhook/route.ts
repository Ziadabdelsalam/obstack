import { applyWebhook, getBilling } from "@/server/billing";
import { dataMode } from "@/server/data";
import { withTransaction } from "@/server/postgres";

/**
 * Polar's webhook endpoint — the ASYNC RECONCILER, never a UX dependency
 * (D110). A plan change is confirmed to the customer by reading the checkout
 * back on return; this route exists so the plan row is still right when the
 * customer closed the tab, when the return never happened, and when a
 * subscription later renews, lapses or is revoked with nobody watching.
 *
 * Local development needs no tunnel because of that split (MEASURED: Polar has
 * no first-party forwarder, and D110 §2(iii) ruled ngrok-class tunnels out).
 *
 * The order of the four steps below is the whole security of this file:
 *
 *  1. the RAW body is read — no framework JSON parse happens before validation,
 *     because a signature is over bytes and re-serialising them is how a valid
 *     signature starts covering a different body;
 *  2. it is validated (`validateEvent` in sandbox mode, an HMAC in fake mode);
 *     a bad signature is a bare 403 with no body detail — an attacker learns
 *     nothing about which part was wrong;
 *  3. exactly D169's consumed set is applied, inline;
 *  4. everything else valid gets a 200, because an unACKed delivery costs ten
 *     retries and there is nothing to retry.
 *
 * A write that fails DOES answer 500: Polar's retries are the recovery, and
 * swallowing it would leave a workspace on the wrong plan forever.
 */
export async function POST(request: Request): Promise<Response> {
  // The prototype deployment keeps no accounts, no plans and no Postgres, so
  // there is nothing here for a webhook to reconcile — the same honest refusal
  // the mock-mode auth surfaces make (D150), with the tripwire log that says a
  // post arrived somewhere no delivery should be pointed.
  if (dataMode === "mock") {
    console.error("[billing] webhook posted in mock mode — this deployment has no billing");
    return new Response(null, { status: 404 });
  }

  const rawBody = await request.text();
  let event;
  try {
    event = getBilling().verifyWebhook(rawBody, Object.fromEntries(request.headers));
  } catch (error) {
    // The refusal is silent to the SENDER and loud in our log: a deployment
    // whose `POLAR_WEBHOOK_SECRET` is missing rejects every delivery in exactly
    // the same 403 a forgery gets, and without this line the two are
    // indistinguishable to whoever is asking why nothing reconciles. The
    // message names the failure, never the body and never a secret.
    console.error(
      `[billing] webhook rejected: ${error instanceof Error ? error.message : "unverifiable"}`,
    );
    return new Response(null, { status: 403 });
  }

  // The majority of a valid enum is `none` — an event we have no work for. It
  // writes nothing, so it needs no transaction and no connection; it is just the
  // ACK an unACKed delivery's ten retries would otherwise cost.
  if (event.consumed === "none") return new Response(null, { status: 200 });

  try {
    // Inside one transaction so the convergence `applyWebhook` runs holds its
    // `pg_advisory_xact_lock` across the rail read and the plan write (D195): a
    // re-delivered or reordered event that races another sync of the same
    // workspace waits its turn and reads the present the winner left, rather
    // than interleaving a stale grant over a revocation.
    await withTransaction((query) => applyWebhook(event, query));
  } catch (error) {
    console.error(`[billing] webhook ${event.type} could not be applied`, error);
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
}
