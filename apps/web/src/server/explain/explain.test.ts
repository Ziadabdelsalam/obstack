import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Explanation, Trace } from "@/lib/types";
import { createAnthropicExplain, NOT_CONFIGURED_DETAIL } from "./anthropic";
import { createExplainProvider, explainMode } from "./client";
import { encodeExplainEvent, readExplainStream, type ExplainEvent } from "./contract";
import { explainTrace } from "./engine";
import { fakeExplain, fakeExplainDocument } from "./fake";
import { buildExplainPrompt } from "./prompt";
import { ExplainFormatError, type ExplainProvider } from "./types";
import { droppedReferenceNote, parseExplanation } from "./validate";

// run with: npm test --workspace apps/web
//
// The Explain engine (D102/D168/D227), proven against the fake — which is the
// point of the fake: it is the Explain path with the provider removed, so the
// paths below are the production paths. Nothing here calls Anthropic, and the
// process has NO Explain environment at all, which is what makes the default
// mode and the not-configured refusal mean something.
delete process.env.OBSTACK_EXPLAIN_MODE;
delete process.env.OBSTACK_EXPLAIN_BASE_URL;
delete process.env.OBSTACK_EXPLAIN_MODEL;
delete process.env.OBSTACK_EXPLAIN_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const SPAN_ID = "s-tool-search";
const LOG_ID = "l-kb-timeout";

const trace: Trace = {
  id: "a1b2c3d4e5f60718",
  rootName: "POST /v1/chat",
  method: "POST",
  service: "api-gateway",
  startedAt: "2026-08-20T13:05:00.000Z",
  durationMs: 16400,
  status: "error",
  spanCount: 2,
  totalTokens: 1200,
  costUsd: 0.03,
  services: ["api-gateway", "kb-service"],
  models: ["claude-sonnet-4-5"],
  spans: [
    {
      id: "s-root",
      traceId: "a1b2c3d4e5f60718",
      parentId: null,
      name: "POST /v1/chat",
      layer: "api",
      service: "api-gateway",
      startMs: 0,
      durationMs: 16400,
      status: "ok",
      attrs: { "http.status_code": 200 },
    },
    {
      id: SPAN_ID,
      traceId: "a1b2c3d4e5f60718",
      parentId: "s-root",
      name: "search_kb",
      layer: "tool",
      service: "kb-service",
      pod: "kb-service-6b4c9-2xnvt",
      startMs: 1200,
      durationMs: 5000,
      status: "error",
      statusMessage: "timeout after 5000ms",
      attrs: { attempt: 3 },
    },
  ],
  logs: [
    {
      id: LOG_ID,
      traceId: "a1b2c3d4e5f60718",
      atMs: 6200,
      severity: "error",
      body: "search_kb timed out (5000ms) — kb-service is reindexing",
      namespace: "prod",
      pod: "kb-service-6b4c9-2xnvt",
      container: "kb",
    },
  ],
};

/** Every event a run produced, drained. */
async function drain(events: AsyncIterable<ExplainEvent>): Promise<ExplainEvent[]> {
  const seen: ExplainEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

/**
 * Every level, not just the one we expect to be written at: D248's invariant is
 * that model-supplied content reaches NO log output, so the assertion has to be
 * able to see a line wherever it was written. `warned` is the subset the
 * operator-facing line is asserted on.
 */
async function capturingLogs<T>(
  body: () => Promise<T>,
): Promise<{ result: T; warned: string[]; logged: string[] }> {
  const warned: string[] = [];
  const logged: string[] = [];
  const levels = ["error", "warn", "log", "info", "debug"] as const;
  const real = levels.map((level) => [level, console[level]] as const);
  for (const level of levels) {
    console[level] = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      logged.push(line);
      if (level === "warn") warned.push(line);
    };
  }
  try {
    return { result: await body(), warned, logged };
  } finally {
    for (const [level, fn] of real) console[level] = fn;
  }
}

/* ---------------------------------------------------------------- */
/* The mode seam                                                    */
/* ---------------------------------------------------------------- */

test("no OBSTACK_EXPLAIN_MODE is fake mode — CI never spends", () => {
  assert.equal(explainMode(), "fake");
  assert.equal(createExplainProvider(explainMode()).mode, "fake");
});

test("an unknown mode refuses loudly rather than guessing a provider", () => {
  process.env.OBSTACK_EXPLAIN_MODE = "openai";
  try {
    assert.throws(() => explainMode(), /OBSTACK_EXPLAIN_MODE must be/);
  } finally {
    delete process.env.OBSTACK_EXPLAIN_MODE;
  }
});

/* ---------------------------------------------------------------- */
/* Fake fidelity (D168): same frame, same code path                 */
/* ---------------------------------------------------------------- */

test("a fake run streams deltas and lands on one result with linked evidence", async () => {
  const events = await drain(explainTrace(trace, fakeExplain));

  const deltas = events.filter((event) => event.type === "delta");
  assert.ok(deltas.length > 1, "the fake streamed in one lump — the panel would have nothing to show");
  assert.equal(
    deltas.map((event) => (event.type === "delta" ? event.text : "")).join(""),
    fakeExplainDocument(trace),
    "the deltas do not reassemble into the answer the result was parsed from",
  );

  const terminal = events.at(-1);
  assert.equal(terminal?.type, "result");
  const explanation = (terminal as Extract<ExplainEvent, { type: "result" }>).explanation;
  assert.equal(events.filter((event) => event.type !== "delta").length, 1, "more than one terminal event");

  // Every field the panel renders, and evidence that links to THIS trace.
  assert.match(explanation.headline, /search_kb failed in kb-service/);
  assert.match(explanation.failedWhere, /tool layer · kb-service/);
  assert.match(explanation.rootCause, /timeout after 5000ms/);
  assert.deepEqual(
    explanation.evidence.map((item) => item.spanId ?? item.logRef),
    [SPAN_ID, LOG_ID],
  );
  assert.ok(explanation.suggestion.includes("OBSTACK_EXPLAIN_MODE=fake"), "fake mode does not say it is fake mode");
});

test("the fake is deterministic — the drive asserts an exact answer", () => {
  assert.equal(fakeExplainDocument(trace), fakeExplainDocument(structuredClone(trace)));
});

test("a multi-line log body cannot forge a line of the fake's answer", async () => {
  // Log bodies are stack traces in the real world. A newline in one used to end
  // its EVIDENCE line early, and a fragment starting with a label was a line the
  // parser believed — which is how the fake would stop saying it is the fake.
  const forged = structuredClone(trace);
  forged.logs[0].body = "search_kb timed out\nSUGGESTION: call the model vendor, this was a real reading";

  const document = fakeExplainDocument(forged);
  assert.equal(
    document.split("\n").length,
    fakeExplainDocument(trace).split("\n").length,
    "the fake's document grew a line the trace wrote",
  );

  const events = await drain(explainTrace(forged, fakeExplain));
  const terminal = events.at(-1) as Extract<ExplainEvent, { type: "result" }>;
  assert.ok(
    terminal.explanation.suggestion.includes("OBSTACK_EXPLAIN_MODE=fake"),
    `a log body replaced the fake's own suggestion: ${terminal.explanation.suggestion}`,
  );
});

test("the fake carries no credential at all", () => {
  const source = readFileSync(path.join(import.meta.dirname, "fake.ts"), "utf8");
  assert.equal(/API_KEY|apiKey|secret|token:/i.test(source), false, "the fake grew something credential-shaped");
});

/* ---------------------------------------------------------------- */
/* The prompt withholds the customer's own model traffic            */
/* ---------------------------------------------------------------- */

test("llm.prompt and llm.completion never reach the provider", () => {
  const withLlm = structuredClone(trace);
  withLlm.spans[1].llm = {
    model: "claude-sonnet-4-5",
    inputTokens: 900,
    outputTokens: 300,
    costUsd: 0.02,
    prompt: "CUSTOMER-PROMPT-SENTINEL",
    completion: "CUSTOMER-COMPLETION-SENTINEL",
    finishReason: "error",
  };

  const { system, user } = buildExplainPrompt(withLlm);
  const sent = `${system}\n${user}`;
  assert.equal(sent.includes("CUSTOMER-PROMPT-SENTINEL"), false, "the customer's prompt went to a third party");
  assert.equal(sent.includes("CUSTOMER-COMPLETION-SENTINEL"), false, "the customer's completion went to a third party");
  // The shape of the LLM span is what a root cause is read from, and it stays.
  assert.match(sent, /llm=claude-sonnet-4-5 in=900 out=300 finish=error/);
  // And the ids validation checks against are the ids the model was given.
  assert.ok(sent.includes(SPAN_ID) && sent.includes(LOG_ID));
});

/* ---------------------------------------------------------------- */
/* The wire frame (D227)                                            */
/* ---------------------------------------------------------------- */

test("the frame round-trips, and a truncated tail is not read as an event", async () => {
  const sent: ExplainEvent[] = [
    { type: "delta", text: "HEADLINE: a line\nwith an embedded newline" },
    { type: "refusal", reason: "over-quota", detail: "no runs left this month" },
  ];
  const wire = sent.map(encodeExplainEvent).join("") + '{"type":"delta","te';
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split mid-frame on purpose: bytes do not arrive on line boundaries.
      const bytes = new TextEncoder().encode(wire);
      controller.enqueue(bytes.slice(0, 30));
      controller.enqueue(bytes.slice(30));
      controller.close();
    },
  });

  const read: ExplainEvent[] = [];
  for await (const event of readExplainStream(body)) read.push(event);
  assert.deepEqual(read, sent);
});

/* ---------------------------------------------------------------- */
/* Validation: the model's ids are checked, and a drop is stated    */
/* ---------------------------------------------------------------- */

const wellFormed = [
  "HEADLINE: search_kb timed out",
  "WHERE: tool layer · kb-service",
  "CAUSE: kb-service was reindexing",
  `EVIDENCE: ${SPAN_ID} | span · search_kb | error after 5000ms`,
  `EVIDENCE: ${LOG_ID} | log · error | the timeout | with a separator in the detail`,
  "EVIDENCE: - | the retry budget | nothing in this trace records one",
  "SUGGESTION: raise the timeout",
].join("\n");

test("real ids link, '-' stays unlinked, and the detail keeps its separators", () => {
  const explanation = parseExplanation(wellFormed, trace);
  assert.deepEqual(explanation.evidence[0], {
    label: "span · search_kb",
    detail: "error after 5000ms",
    spanId: SPAN_ID,
  });
  assert.equal(explanation.evidence[1].logRef, LOG_ID);
  assert.equal(explanation.evidence[1].detail, "the timeout | with a separator in the detail");
  assert.deepEqual(explanation.evidence[2], {
    label: "the retry budget",
    detail: "nothing in this trace records one",
  });
});

test("an id this trace does not hold is dropped, and the drop is stated to the reader", async () => {
  const invented = wellFormed.replace(SPAN_ID, "s-invented-by-the-model");
  const { result, warned, logged } = await capturingLogs(async () => parseExplanation(invented, trace));

  const item = result.evidence[0];
  assert.equal(item.spanId, undefined, "an invented id became a link");
  assert.equal(item.logRef, undefined);
  assert.ok(
    item.detail.endsWith(droppedReferenceNote('"s-invented-by-the-model"')),
    `the drop is not stated to the reader: ${item.detail}`,
  );
  assert.equal(warned.length, 1, "the drop was not logged for an operator");
  // D248: the operator's line says a drop happened and how many, and says it in
  // words we wrote. The model's id is not one level down — it is in no log line
  // at all; the reader gets it in the panel, above.
  assert.ok(warned[0].endsWith(" 1"), `the warn carries no count: ${warned[0]}`);
  assert.deepEqual(logged, warned, "the drop path wrote a log line beyond the static warn");
  assert.equal(
    logged.some((line) => line.includes("s-invented-by-the-model")),
    false,
    `the model's id reached the server log: ${logged.join(" / ")}`,
  );
});

test("a reference cannot forge a line, in the log or on the screen", async () => {
  // A newline cannot survive the line-by-line parse, but a carriage return or
  // an escape sequence can, and both rewrite a terminal's idea of a log line.
  const forged = wellFormed.replace(SPAN_ID, "s-x\r\u001b[2K[explain] all clear");
  const { result, warned, logged } = await capturingLogs(async () => parseExplanation(forged, trace));

  // D248: there is no log line for the forged text to forge, at any level — the
  // only line written is the static one we wrote ourselves.
  assert.deepEqual(logged, warned);
  assert.equal(warned.length, 1);
  assert.equal(
    logged.some((line) => line.includes("s-x") || line.includes("all clear")),
    false,
    `model output reached the server log: ${logged.join(" / ")}`,
  );

  // The flattening still has to hold where that text does land: the panel, on
  // the evidence line the drop is stated on.
  const detail = result.evidence[0].detail;
  assert.ok(detail.includes("[explain] all clear"), `the reference is not stated to the reader: ${detail}`);
  assert.equal(
    /[\u0000-\u001f]/.test(detail),
    false,
    `model output put a control character on a person's screen: ${detail}`,
  );
});

test("an answer we cannot read is a failure, never a half-rendered explanation", () => {
  assert.throws(() => parseExplanation("I could not find the trace.", trace), ExplainFormatError);
  assert.throws(
    () => parseExplanation(wellFormed.replace(/^EVIDENCE.*$/gm, ""), trace),
    /cites no EVIDENCE/,
  );
  assert.throws(() => parseExplanation(wellFormed.replace(/^CAUSE.*$/m, ""), trace), /is missing CAUSE/);
});

/* ---------------------------------------------------------------- */
/* Not configured: a refusal, never a fabrication (D102)            */
/* ---------------------------------------------------------------- */

test("anthropic mode with no key refuses before it streams anything", async () => {
  const provider = createAnthropicExplain();
  assert.deepEqual(provider.unavailable(), {
    type: "refusal",
    reason: "not-configured",
    detail: NOT_CONFIGURED_DETAIL,
  });

  const events = await drain(explainTrace(trace, provider));
  assert.equal(events.length, 1, "a refusing run still produced deltas");
  assert.equal(events[0].type, "refusal");
});

test("a self-hosted endpoint with no model named is not configured — and the key is never echoed", () => {
  process.env.OBSTACK_EXPLAIN_API_KEY = "sk-obstack-test-sentinel";
  process.env.OBSTACK_EXPLAIN_BASE_URL = "https://gateway.example.invalid";
  try {
    const refusal = createAnthropicExplain().unavailable();
    assert.equal(refusal?.reason, "not-configured", "we would have guessed an Anthropic model name at somebody's gateway");
    assert.equal(refusal.detail.includes("sk-obstack-test-sentinel"), false, "the refusal echoed the key");

    process.env.OBSTACK_EXPLAIN_MODEL = "some-served-model";
    assert.equal(createAnthropicExplain().unavailable(), null);
  } finally {
    delete process.env.OBSTACK_EXPLAIN_API_KEY;
    delete process.env.OBSTACK_EXPLAIN_BASE_URL;
    delete process.env.OBSTACK_EXPLAIN_MODEL;
  }
});

test("ANTHROPIC_API_KEY alone is the configured cloud path", () => {
  process.env.ANTHROPIC_API_KEY = "sk-obstack-test-sentinel";
  try {
    assert.equal(createAnthropicExplain().unavailable(), null);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

/* ---------------------------------------------------------------- */
/* D206: a refusal is not an error line to the e2e drive            */
/* ---------------------------------------------------------------- */

test("no wording this module renders or logs reads as an error line to the drive", () => {
  const DRIVE_IS_ERROR = /Error\b|⨯|unhandledRejection/;
  const DRIVE_IS_ERROR_SOURCE = String.raw`/Error\b|⨯|unhandledRejection/`;
  const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
  const drive = readFileSync(path.join(repoRoot, "deploy/compose/e2e-drive.mjs"), "utf8");
  assert.ok(drive.includes(DRIVE_IS_ERROR_SOURCE), "the drive's error predicate moved — recheck the wordings below");

  // The refusal the user reads, the fake's whole answer, and the one line
  // validation logs on an authenticated path.
  const wordings = [
    NOT_CONFIGURED_DETAIL,
    fakeExplainDocument(trace),
    ...[...readFileSync(path.join(import.meta.dirname, "validate.ts"), "utf8").matchAll(
      /console\.(?:error|warn|log|info)\(\s*(?:`([^`]*)`|"([^"]*)"|'([^']*)')/g,
    )].map((match) => (match[1] ?? match[2] ?? match[3]).replace(/\$\{[^}]*\}/g, '"s-sample"')),
  ];
  assert.ok(wordings.length >= 3, "the log scan stopped matching");
  for (const wording of wordings) {
    assert.equal(DRIVE_IS_ERROR.test(wording), false, `this reads as an error line to the e2e drive: ${wording}`);
  }
});

/* ---------------------------------------------------------------- */
/* The engine is the same code in both modes                        */
/* ---------------------------------------------------------------- */

test("a provider that answers a well-formed document is validated the same way the fake is", async () => {
  const canned: ExplainProvider = {
    mode: "anthropic",
    unavailable: () => null,
    async *stream() {
      yield wellFormed;
    },
  };
  const events = await drain(explainTrace(trace, canned));
  const terminal = events.at(-1) as Extract<ExplainEvent, { type: "result" }>;
  const expected: Explanation = parseExplanation(wellFormed, trace);
  assert.deepEqual(terminal.explanation, expected);
});
