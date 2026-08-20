import { dataForSessionContext, dataMode } from "@/server/data";
import { explainTrace, getExplain } from "@/server/explain";
import { EXPLAIN_CONTENT_TYPE, encodeExplainEvent, type ExplainEvent } from "@/server/explain/contract";
import { spendExplainRun } from "@/server/explain/quota";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * One Explain run (D227). POST, because a run is a SPEND and not a read (D189):
 * it consumes one of the workspace's monthly Explain runs, so it must not sit
 * behind a URL a prefetch, a crawler or a browser's back button can replay.
 *
 * The order below is D225's, and each step is where it is because of what the
 * one after it costs:
 *
 *   1. mock guard — 404, this route does not exist in a deployment with no data.
 *   2. session — the workspace comes from the cookie, never the URL (D96/D148).
 *   3. the trace — read through the session's scoped facade, so the `id` in the
 *      URL is a resource id inside the tenant and cannot reach out of it. Read
 *      before the spend: a trace that is not there is not a run anybody had.
 *   4. config check — a deployment with no model configured refuses BEFORE it
 *      takes anyone's run, because "we cannot do this" must be free to say.
 *   5. the atomic increment-or-refuse (`spendExplainRun`).
 *   6. the provider.
 *
 * A PROVIDER ERROR AFTER STEP 5 IS A COUNTED RUN. There is no refund path, and
 * that is deliberate: refunding needs the read-then-write that D225's single
 * statement exists to avoid, and a failed run has usually already cost us the
 * tokens it got to. The trade is a caller who occasionally loses a run to our
 * failure, against a cap a failing provider would otherwise let them loop past.
 *
 * The response is the NDJSON frame (`server/explain/contract.ts`) in every
 * outcome that got past the session: refusals are PRODUCT outcomes, so they
 * travel as a terminal `refusal` event with a 200, and the panel has one parse
 * path rather than a status-code fork it would have to keep in step. Status
 * codes are kept for what is not a product outcome — 401 no session, 404 no
 * such trace.
 *
 * Nothing here logs the trace, the model's answer, or any credential: the only
 * lines this file writes name the workspace and the refusal, which is what the
 * S3.4 token-hygiene rule extends to Explain.
 */

/** Rendered to the user verbatim, and D206-safe: no refusal reads as an error line to the drive. */
export function overQuotaDetail(quota: number): string {
  return (
    `This workspace has used all ${quota} Explain runs its plan includes this month, so no run was made. ` +
    `The allowance resets at the start of next month; a larger plan raises it.`
  );
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Mock mode has no workspace, no Postgres to meter against and no Explain
  // button on this path (the demo renders its prepared stories, D230), so a
  // request here came from somewhere no visitor can be — 404 plus the tripwire
  // at error level, the `onboarding/status` treatment (D193).
  if (dataMode === "mock") {
    console.error("[explain] run posted in mock mode — this deployment explains nothing");
    return new Response(null, { status: 404 });
  }

  const session = await getSessionContext();
  // A fetch is not a navigation: an unauthenticated caller gets the status code
  // rather than a login page rendered inside a stream.
  if (!session) return new Response(null, { status: 401 });

  const { id } = await params;
  const trace = await dataForSessionContext(session).getTrace(id);
  if (!trace) return new Response(null, { status: 404 });

  const provider = getExplain();
  const unavailable = provider.unavailable();
  if (unavailable) return explainResponse(oneEvent(unavailable));

  const run = await spendExplainRun(session.workspaceId, queryRows);
  if (!run.allowed) {
    // Logged because a workspace hitting its cap is a fact we want to see, and
    // worded so the e2e drive's log check does not read a correct product
    // behaviour on an authenticated path as a failure (D206).
    console.warn(`[explain] run refused for workspace ${session.workspaceId}: plan allowance spent for this month`);
    return explainResponse(
      oneEvent({ type: "refusal", reason: "over-quota", detail: overQuotaDetail(run.quota) }),
    );
  }

  return explainResponse(explainTrace(trace, provider));
}

async function* oneEvent(event: ExplainEvent): AsyncGenerator<ExplainEvent> {
  yield event;
}

/**
 * The frame on the wire. Exported because it is the half of this route that can
 * be proven without a session and a Postgres behind it.
 *
 * A throw from the generator ends the stream WITHOUT a terminal event, which is
 * exactly what the contract says a failed run looks like — the panel reports a
 * truncated stream instead of rendering the deltas it did get as an answer. The
 * status line is long gone by then, so an error status is not available to us;
 * the error is logged here, where the run happened, and the caller learns it
 * from the missing terminal event.
 */
export function explainResponse(events: AsyncGenerator<ExplainEvent>): Response {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await events.next();
        if (done) return void controller.close();
        controller.enqueue(new TextEncoder().encode(encodeExplainEvent(value)));
      } catch (error) {
        console.error("[explain] run failed mid-stream:", error);
        controller.close();
      }
    },
    cancel() {
      // The reader went away — a closed tab, a cancelled fetch. Stop asking the
      // provider for chunks nobody will read.
      void events.return(undefined);
    },
  });

  return new Response(stream, {
    headers: { "content-type": EXPLAIN_CONTENT_TYPE, "cache-control": "no-store" },
  });
}
