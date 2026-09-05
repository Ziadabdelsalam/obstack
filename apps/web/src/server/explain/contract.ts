import type { Explanation } from "@/lib/types";

/**
 * The Explain wire frame, stated once (D227). The fake emits it, the Anthropic
 * path emits it, the route writes it and the panel reads it — so "what does an
 * Explain run send down the wire" has one answer and no second copy.
 *
 * NOT `server-only`, deliberately and against the rest of this directory: the
 * panel is a client component and it parses this frame, so the frame itself has
 * to be importable from the browser. Everything else behind `index.ts` is
 * server-side; a client that reached past this file would be importing the
 * engine, which is the boundary this exception exists to keep visible.
 *
 * Newline-delimited JSON (`application/x-ndjson`), because the alternative —
 * SSE — buys retry semantics we do not want for a metered POST: a run is a
 * spend (D189/D225), so a transport that silently re-runs it is wrong.
 *
 * A well-formed stream is zero or more `delta` events followed by exactly ONE
 * terminal event, `result` or `refusal`. A stream that ends without a terminal
 * event is a failure — the model or the process died mid-run — and the reader
 * must say so rather than render a partial summary as if it were an answer.
 */

/** The response `content-type`, named here so the route and any reader agree. */
export const EXPLAIN_CONTENT_TYPE = "application/x-ndjson";

/**
 * Why a run produced no explanation. All three are honest product outcomes,
 * not faults: `not-configured` is a deployment with no model behind it (D102 —
 * the surface says so rather than fabricating), `over-quota` is the plan's
 * Explain allowance spent for the month (D225), and `no-evidence` is an
 * incident whose window holds no alert, change or trace to read (D558 — the
 * RCA route refuses before it spends rather than bill for a cause a model would
 * have to invent). Their `detail` strings are rendered to the user verbatim,
 * and they are also logged on an authenticated path, so they must not read as
 * an error line to the e2e drive's log check (D206). The panel never switches
 * on `reason` — it renders `detail` — which is why a third member needed no
 * panel change.
 */
export type ExplainRefusalReason = "not-configured" | "over-quota" | "no-evidence";

export type ExplainEvent =
  | { type: "delta"; text: string }
  | { type: "result"; explanation: Explanation }
  | { type: "refusal"; reason: ExplainRefusalReason; detail: string };

export type ExplainRefusal = Extract<ExplainEvent, { type: "refusal" }>;

/** One frame, terminated. `JSON.stringify` cannot emit a bare newline, so the delimiter is safe. */
export function encodeExplainEvent(event: ExplainEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * The frame's reader, living beside its writer so a change to one is a change
 * to a file the other's author is already in. Bytes arrive on no particular
 * boundary, so the tail of a chunk is held back until its newline arrives; a
 * trailing partial line at end-of-stream is DROPPED rather than parsed, which
 * is what makes a truncated stream look truncated instead of malformed.
 */
export async function* readExplainStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ExplainEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim()) yield JSON.parse(line) as ExplainEvent;
        newline = buffered.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
