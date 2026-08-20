import assert from "node:assert/strict";
import test from "node:test";
import { EXPLAIN_CONTENT_TYPE, readExplainStream, type ExplainEvent } from "@/server/explain/contract";
import { explainResponse, overQuotaDetail } from "./route";

// run with: npm test --workspace apps/web
//
// The route's WIRE, which is the half of it that needs neither a session nor a
// Postgres: the frame the panel parses (D227), the headers that frame arrives
// under, and what a run that dies mid-stream looks like on the other end. The
// steps above it — mock guard, session, trace, config check, spend — are
// asserted where they can be: the mock-mode refusal in
// `src/app/signup/mock-mode.test.ts` (D152's standing list), the atomic spend
// in `server/explain/quota.integration.test.ts` against a real Postgres.

const REFUSAL: ExplainEvent = {
  type: "refusal",
  reason: "over-quota",
  detail: overQuotaDetail(20),
};

async function* events(...list: ExplainEvent[]): AsyncGenerator<ExplainEvent> {
  for (const event of list) yield event;
}

const drain = async (response: Response): Promise<ExplainEvent[]> => {
  const out: ExplainEvent[] = [];
  assert.ok(response.body, "a streamed response with no body");
  for await (const event of readExplainStream(response.body)) out.push(event);
  return out;
};

test("the frame arrives as NDJSON, uncached, event per line", async () => {
  const response = explainResponse(
    events(
      { type: "delta", text: "HEADLINE: the tool call" },
      { type: "delta", text: " timed out\n" },
      { type: "result", explanation: { headline: "h", failedWhere: "w", rootCause: "c", evidence: [], suggestion: "s" } },
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), EXPLAIN_CONTENT_TYPE);
  // A metered POST answered from a cache would be a run somebody paid for and
  // then got a stale copy of.
  assert.equal(response.headers.get("cache-control"), "no-store");

  const received = await drain(response);
  assert.equal(received.length, 3);
  // The newline INSIDE a delta is the point: the frame is JSON-encoded per
  // line, so model text carrying a newline cannot forge a second event.
  assert.deepEqual(received[1], { type: "delta", text: " timed out\n" });
  assert.equal(received[2]?.type, "result");
});

test("a refusal is a terminal event with a 200, not a status code (D227)", async () => {
  const response = explainResponse(events(REFUSAL));
  assert.equal(response.status, 200, "the request succeeded; the product refused");
  assert.deepEqual(await drain(response), [REFUSAL]);
});

test("a run that dies mid-stream ends with NO terminal event", async () => {
  // The contract's failure shape: the status line is already sent, so the only
  // honest signal left is the absence of a terminal event — the panel says the
  // run was cut off rather than rendering the deltas it got as an answer.
  async function* dies(): AsyncGenerator<ExplainEvent> {
    yield { type: "delta", text: "HEADLINE: " };
    throw new Error("the provider hung up");
  }

  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  let received: ExplainEvent[];
  try {
    received = await drain(explainResponse(dies()));
  } finally {
    console.error = real;
  }

  assert.deepEqual(received, [{ type: "delta", text: "HEADLINE: " }]);
  assert.ok(
    !received.some((event) => event.type === "result" || event.type === "refusal"),
    "a failure must not be framed as an answer",
  );
  // A failure is logged at ERROR level on purpose — the e2e drive's log check
  // is meant to see this one, which is what the D206 wording rule is NOT about
  // (`explain-wording.test.ts`).
  assert.match(logged[0] ?? "", /\[explain\] run failed mid-stream/);
});

test("a reader that goes away stops the run", async () => {
  // A cancelled fetch — a closed tab — must not leave the provider streaming
  // chunks into a body nobody reads.
  let closed = false;
  async function* watched(): AsyncGenerator<ExplainEvent> {
    try {
      for (;;) yield { type: "delta", text: "..." };
    } finally {
      closed = true;
    }
  }

  const response = explainResponse(watched());
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(closed, true, "the generator was returned, not abandoned");
});
