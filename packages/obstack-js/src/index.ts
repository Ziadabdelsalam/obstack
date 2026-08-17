/**
 * obstack-js — the whole public surface.
 *
 *   import { init } from "obstack-js";
 *   init();
 *
 * as the first thing the process runs, then `traceAgent` / `traceTool` around
 * the steps worth seeing. Everything else — the api layer, the LLM spans, the
 * GenAI attributes, the OTLP export — follows from those two lines.
 */
export { init, type ObstackSDK } from "./init";
export { traceAgent, traceTool } from "./helpers";
