/**
 * The model provider, faked — deterministically, and behind a real HTTP
 * endpoint.
 *
 * The point of doing it this way rather than stubbing the clients (D77(d)):
 * `openai` and the Vercel AI SDK really run, really serialise a request, really
 * parse a response, and the instrumentation really observes them. A test that
 * bypassed the client would prove nothing about auto-instrumentation.
 *
 * The response is an OpenAI chat completion, so one endpoint serves both legs,
 * and it reports `gpt-4o-mini` — a model obstack's ingest prices, so `cost_usd`
 * comes out non-zero on the fake path too.
 */

const DEFAULT_MODEL = "gpt-4o-mini";

export function chatCompletion(request: Record<string, unknown>): unknown {
  const model = typeof request.model === "string" ? request.model : DEFAULT_MODEL;
  const prompt = promptText(request.messages);
  const text = reply(prompt);

  return {
    id: "chatcmpl-obstack-sample",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text, refusal: null },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: tokens(prompt),
      completion_tokens: tokens(text),
      total_tokens: tokens(prompt) + tokens(text),
    },
  };
}

/** A completion that reads like the real thing and never varies: a pure
 *  function of the request, so two runs of the sample produce the same trace
 *  down to the token counts. */
function reply(prompt: string): string {
  return (
    `Reading the ${tokens(prompt)} tokens of context: start with the agent step's own duration. ` +
    "The tool call and the model call both sit inside it, so a slow step is not automatically a slow model."
  );
}

/** Roughly four characters per token — the usual English approximation. Real
 *  counts, so the token columns and the cost are populated by ingest exactly as
 *  they would be for a live provider. */
function tokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/**
 * Flattens the request's messages into the text the fake answers from. Both
 * callers send OpenAI chat messages, but the Vercel AI SDK sends content as an
 * array of parts where the `openai` client sends a plain string.
 */
function promptText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((message: unknown) => {
      const content = (message as { content?: unknown })?.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part: unknown) => {
          const text = (part as { text?: unknown })?.text;
          return typeof text === "string" ? text : "";
        })
        .join(" ");
    })
    .join("\n");
}
