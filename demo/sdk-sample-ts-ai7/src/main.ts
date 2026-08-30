/**
 * The obstack-js sample — and its entire telemetry setup, which is the two
 * lines below.
 *
 * `POST /chat` runs one agent turn and produces the four-layer trace obstack
 * renders:
 *
 *     POST /chat                        api    (node:http server span, auto)
 *     └─ agent.answer_question          agent  (obstack.agent.step)
 *        ├─ tool.knowledge_lookup       tool   (obstack.tool.name)
 *        ├─ chat gpt-4o-mini            llm    (Vercel AI SDK 7, on by default)
 *        ├─ chat gpt-4o-mini            llm    (openai chat completions, patched)
 *        └─ chat gpt-4o-mini            llm    (openai Responses API, patched)
 *
 * Nothing here imports @opentelemetry/*: `init()` registers the HTTP, OpenAI
 * and Vercel-AI instrumentation, and the api and llm layers follow from that
 * without the app writing a line of OTel. The two spans no library can infer —
 * which agent step is running, which tool it reached for — are the two
 * `traceAgent` / `traceTool` calls in agent.ts.
 */
import { init } from "obstack-js";

const sdk = init();

// Required, not imported, and only here: obstack-js patches `openai` and
// `node:http` as they are required, so a module pulled in above `init()` would
// keep its unpatched copy. Everything this app does hangs off this one line.
const { start } = require("./server") as typeof import("./server");

const server = start();

// obstack-js installs no signal handlers on purpose (a library that takes over
// SIGTERM is a surprise in someone else's app), so the app awaits the flush
// itself — without it the telemetry of the last request dies with the process.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close();
    void sdk.shutdown().then(() => process.exit(0));
  });
}
