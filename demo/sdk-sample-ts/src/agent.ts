/**
 * The agent turn. Every telemetry line in this file is an obstack-js call —
 * `traceAgent` and `traceTool` — and the three model calls are ordinary client
 * code: the LLM spans, their prompts, completions and token counts come from
 * the instrumentation `init()` registered, not from anything written here.
 *
 * Three LLM legs on purpose, because obstack-js covers three Node paths and
 * each deserves an end-to-end trace (D77(e), D308):
 *
 *   1. `generateText` from the Vercel AI SDK, with `experimental_telemetry`
 *      enabled — `ai` emits its own span and obstack-js's span processor
 *      rewrites it into the attributes ingest reads.
 *   2. `openai`'s `chat.completions.create` — patched at require time, so the
 *      span is obstack-js's own.
 *   3. `openai`'s `responses.create` — the newer OpenAI surface, a second patch
 *      on a second module, and the one whose finish reason is the response
 *      `status` rather than a `finish_reason` (D301).
 *
 * All three talk to the fake model endpoint this same app serves (see
 * server.ts).
 *
 * This module is loaded by main.ts *after* `init()` has run, which is what
 * makes plain imports safe here.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { traceAgent, traceTool } from "obstack-js";
import OpenAI from "openai";
import { PORT } from "./config";

/** The model the fake reports. It is in obstack's pricing table, so the trace
 *  lands with a non-zero cost the way a real one would. */
const MODEL = "gpt-4o-mini";

/** This app's own OpenAI-compatible endpoint. */
const BASE_URL = `http://127.0.0.1:${PORT}/v1`;

/** Both clients insist on some key being present before they will send a
 *  request. The fake ignores it; there is no credential anywhere in this repo. */
const PLACEHOLDER_KEY = "sk-obstack-sample-no-key-needed";

const SYSTEM_PROMPT =
  "You are the obstack sample agent. Answer the operator's question in two sentences, using the retrieved facts.";

/** The tool's "knowledge base". Small and fixed: the sample is about the shape
 *  of the telemetry, not about retrieval. */
const KNOWLEDGE: Record<string, string> = {
  latency: "the p99 on checkout tracks the vector-store lookup inside the agent step",
  token: "the summarizer agent re-sends the full conversation on every turn",
  error: "the payments API started returning 502s nine minutes after the last deploy",
};
const FALLBACK_FACT = "no runbook entry matches this question yet";

const vercelModel = createOpenAI({ baseURL: BASE_URL, apiKey: PLACEHOLDER_KEY }).chat(MODEL);
const openai = new OpenAI({ baseURL: BASE_URL, apiKey: PLACEHOLDER_KEY });

export interface Answer {
  answer: string;
  draft: string;
  model: string;
  facts: string[];
}

export async function answer(question: string): Promise<Answer> {
  return traceAgent("answer_question", async () => {
    const facts = await traceTool("knowledge_lookup", () => lookup(question));
    const draft = await draftAnswer(question, facts);
    const condensed = await condense(draft);
    const final = await makeActionable(condensed);
    console.log(`agent answered in ${final.length} characters`);
    return { answer: final, draft, model: MODEL, facts };
  });
}

/** Leg 1 — the Vercel AI SDK. `experimental_telemetry` is what makes `ai` emit
 *  the span obstack-js translates; without it the call is invisible. */
async function draftAnswer(question: string, facts: string[]): Promise<string> {
  const result = await generateText({
    model: vercelModel,
    system: SYSTEM_PROMPT,
    prompt: `Retrieved facts:\n${facts.map((fact) => `- ${fact}`).join("\n")}\n\nQuestion: ${question}`,
    experimental_telemetry: { isEnabled: true },
  });
  return result.text;
}

/** Leg 2 — the openai client's chat completions, called exactly as an
 *  application would. */
async function condense(draft: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: "Condense the draft answer into one sentence an on-call engineer can act on." },
      { role: "user", content: draft },
    ],
  });
  return completion.choices[0]?.message.content ?? "";
}

/** Leg 3 — the same client's Responses API (D308). A different module inside
 *  `openai`, so a different obstack-js patch: this call is what proves that one
 *  end to end, and `output_text` is read the way an application reads it. */
async function makeActionable(sentence: string): Promise<string> {
  const response = await openai.responses.create({
    model: MODEL,
    input: `Turn this into the single line an on-call engineer should act on now:\n${sentence}`,
  });
  return response.output_text;
}

/** The tool leg: a plain local lookup, wrapped so the trace shows which tool
 *  the step reached for. */
function lookup(question: string): string[] {
  const asked = question.toLowerCase();
  const facts = Object.entries(KNOWLEDGE)
    .filter(([keyword]) => asked.includes(keyword))
    .map(([, fact]) => fact);
  console.log(`knowledge lookup returned ${facts.length} fact(s)`);
  return facts.length > 0 ? facts : [FALLBACK_FACT];
}
