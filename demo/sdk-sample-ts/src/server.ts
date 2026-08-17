/**
 * The HTTP surface: the agent endpoint, a health check, and the fake model
 * provider the agent's two LLM legs call.
 *
 * A plain `node:http` server is deliberate — it is the least framework that can
 * still show the api layer of the trace, which the SDK's HTTP instrumentation
 * produces from the server span's `http.request.method` with no help from this
 * file.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { answer } from "./agent";
import { PORT } from "./config";
import { chatCompletion } from "./fake-openai";

const DEFAULT_QUESTION = "Why did checkout p99 latency jump this afternoon?";

export function start(): Server {
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      console.error("request failed:", error);
      send(response, 500, { error: String(error) });
    });
  });

  server.listen(PORT, () => console.log(`sdk-sample-ts listening on :${PORT}`));
  return server;
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = (request.url ?? "/").split("?")[0];

  if (request.method === "GET" && path === "/healthz") {
    return send(response, 200, { status: "ok" });
  }

  if (request.method === "POST" && path === "/chat") {
    const body = await readJson(request);
    const message = typeof body.message === "string" ? body.message : DEFAULT_QUESTION;
    console.log(`chat request received: ${message}`);
    return send(response, 200, await answer(message));
  }

  // The deterministic model provider. Both LLM legs are real client calls over
  // real HTTP with `baseURL` pointed here (D77(d)), so the instrumentation
  // observes the libraries doing their actual work — no API key, no network,
  // and the same answer every run.
  if (request.method === "POST" && path === "/v1/chat/completions") {
    return send(response, 200, chatCompletion(await readJson(request)));
  }

  send(response, 404, { error: `no route for ${request.method} ${path}` });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
