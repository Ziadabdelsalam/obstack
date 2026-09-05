import "server-only";
import { EXPLAIN_CONTENT_TYPE, encodeExplainEvent, type ExplainEvent } from "./contract";

/**
 * The frame's ONE writer (D227, lifted here by D551). `contract.ts` states that
 * what an Explain run sends down the wire has one answer; until S7.4 that
 * answer was written inside `app/app/traces/[id]/explain/route.ts`, which was
 * fine while there was one route. The incident RCA route (`app/app/incidents/
 * [id]/rca/route.ts`) is a second caller, and a second `ReadableStream` with
 * its own `pull`/`cancel` would be a second answer to the same question — so
 * the writer moved behind the barrel and both routes call it.
 *
 * What is NOT here, on purpose: the D225 order. Each route spells its own
 * mock guard, session, resource read, `unavailable()` check, spend and
 * over-quota log line, six lines copied rather than lifted, because the order
 * is the artifact being proven and a `withExplainRun()` helper that owned it
 * would make "does this route check config before it spends" a question about
 * a file the reviewer is not in.
 */

/** A single terminal event as a stream — the refusal shape both routes answer with. */
export async function* oneEvent(event: ExplainEvent): AsyncGenerator<ExplainEvent> {
  yield event;
}

/**
 * The frame on the wire. Exported because it is the half of a route that can
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
