import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_RATE_LIMIT, MCP_SERVER_NAME, MCP_TOOL_NAMES } from "@/lib/mcp-types";
import type { Trace } from "@/lib/types";
import type { ResolvedApiKey } from "@/server/api-keys";
import type { ScopedClickHouse } from "@/server/clickhouse";
import type { WorkspaceData } from "@/server/data";
import type { QueryRows } from "@/server/postgres";
import { resetRateLimitsForTests } from "@/server/rate-limit";
import type { McpContext } from "./context";
import { bearerToken, mcpRequestHandler } from "./handler";

/**
 * The endpoint driven by a STOCK client of the protocol (S8.1 D641/D661's
 * unit half): `StreamableHTTPClientTransport` with the handler injected as its
 * `fetch`, so no listener exists and no store is dialled — the fake context
 * answers `get_trace` from memory. The refusal matrix is asserted on raw
 * Requests, because a client that is refused never gets as far as a session.
 */

const ENDPOINT = "http://obstack.test/mcp";
const TRACE = {
  id: "tr_1",
  rootName: "POST /chat",
  method: "POST",
  service: "demo-agent",
  startedAt: "2026-09-14T10:00:00.000Z",
  durationMs: 28,
  status: "ok",
  spanCount: 5,
  totalTokens: 89,
  costUsd: 0.00003,
  services: ["demo-agent"],
  models: ["gpt-4o-mini"],
  spans: [],
  logs: [],
} as unknown as Trace;

const never = (): never => {
  throw new Error("a T3 test reached a store");
};
const fakeData: WorkspaceData = {
  workspaceId: "ws_a",
  getTrace: async (id) => (id === TRACE.id ? TRACE : undefined),
  searchTraces: never,
  getOverview: never,
  searchLogs: never,
};
const KEY: ResolvedApiKey = { keyId: "key_a", workspaceId: "ws_a", scope: "read" };

function handlerWith(resolve: (token: string) => Promise<ResolvedApiKey | null>, mode: "live" | "mock" = "live") {
  return mcpRequestHandler({
    mode,
    resolve,
    contextFor: (key): McpContext => ({
      workspaceId: key.workspaceId,
      keyId: key.keyId,
      scope: key.scope,
      data: fakeData,
      ch: {} as ScopedClickHouse,
      query: never as unknown as QueryRows,
      nowMs: Date.parse("2026-09-14T10:05:00.000Z"),
    }),
  });
}

const resolveOk = async (token: string) => (token === "ok_live_good" ? KEY : null);

function post(handle: (r: Request) => Promise<Response>, headers: Record<string, string>, body: unknown) {
  return handle(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    }),
  );
}
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

async function connectedClient(handle: (r: Request) => Promise<Response>, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) => handle(new Request(url, init)),
  });
  const client = new Client({ name: "handler-test", version: "0" });
  await client.connect(transport);
  return client;
}

beforeEach(() => resetRateLimitsForTests());

test("bearerToken: the scheme case-insensitive, exactly one token, nothing else", () => {
  assert.equal(bearerToken("Bearer ok_live_x"), "ok_live_x");
  assert.equal(bearerToken("bearer ok_live_x"), "ok_live_x");
  assert.equal(bearerToken("  Bearer   ok_live_x  "), "ok_live_x");
  for (const bad of [null, "", "Bearer", "Bearer ", "Basic abc", "Bearer a b", "Token ok_live_x", "ok_live_x"]) {
    assert.equal(bearerToken(bad), null, `${JSON.stringify(bad)} yielded a token`);
  }
});

test("D651: mock mode answers 404 to everything, before any credential is read, and says so once", async () => {
  const seen: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
  try {
    const handle = handlerWith(async () => never(), "mock");
    const res = await post(handle, { authorization: "Bearer ok_live_good" }, INITIALIZE);
    assert.equal(res.status, 404);
  } finally {
    console.error = original;
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0], /\[mcp\] request in mock mode/);
});

test("D642/D6: no header, a malformed header, and an unresolvable token are ONE 401 with the challenge", async () => {
  const handle = handlerWith(resolveOk);
  const refused: Record<string, string>[] = [{}, { authorization: "Basic abc" }, { authorization: "Bearer" }, { authorization: "Bearer ok_live_nope" }];
  for (const headers of refused) {
    const res = await post(handle, headers, INITIALIZE);
    assert.equal(res.status, 401, `${JSON.stringify(headers)} was not refused`);
    assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="obstack"');
    assert.equal(await res.text(), "", "a refusal carried a body");
  }
});

test("D641: a stock client initialises, lists exactly the registry, and calls get_trace end to end", async () => {
  const handle = handlerWith(resolveOk);
  const client = await connectedClient(handle, "ok_live_good");
  try {
    assert.equal(client.getServerVersion()?.name, MCP_SERVER_NAME);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...MCP_TOOL_NAMES].sort());
    const trace = tools.find((t) => t.name === "get_trace");
    assert.equal(trace?.annotations?.readOnlyHint, true);
    assert.equal(trace?.annotations?.destructiveHint, false);
    const mint = tools.find((t) => t.name === "issue_ingest_key");
    assert.equal(mint?.annotations?.readOnlyHint, false, "the one mutation is advertised as read-only");
    assert.equal(mint?.annotations?.destructiveHint, false);

    const hit = await client.callTool({ name: "get_trace", arguments: { id: "tr_1" } });
    assert.equal(hit.isError, undefined);
    assert.deepEqual(hit.structuredContent, TRACE);
    assert.deepEqual(JSON.parse((hit.content as { type: string; text: string }[])[0].text), TRACE);

    const miss = await client.callTool({ name: "get_trace", arguments: { id: "tr_missing" } });
    assert.equal(miss.isError, true);
    assert.equal((miss.content as { text: string }[])[0].text, "no trace with this id in your workspace");

    // D650's other shape: a store this fake context cannot reach is ONE
    // sentence for the agent and one log line here — never a stack.
    const seen: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void seen.push(args);
    let down;
    try {
      down = await client.callTool({ name: "list_issues", arguments: {} });
    } finally {
      console.error = original;
    }
    assert.equal(down.isError, true);
    assert.equal((down.content as { text: string }[])[0].text, "obstack could not read the trace store for this request");
    assert.equal(seen.length, 1, "the cause was logged more or less than once");
  } finally {
    await client.close();
  }
});

test("D672/D641: the notification stream is declined with 405 after the 401 gate, and DELETE is the SDK's stateless answer", async () => {
  const handle = handlerWith(resolveOk);
  const unauth = await handle(new Request(ENDPOINT, { method: "GET", headers: { accept: "text/event-stream" } }));
  assert.equal(unauth.status, 401, "a method answer leaked before the credential was checked");
  const authed = await handle(
    new Request(ENDPOINT, { method: "GET", headers: { accept: "text/event-stream", authorization: "Bearer ok_live_good" } }),
  );
  assert.equal(authed.status, 405);
  assert.equal(authed.headers.get("allow"), "POST, DELETE");
  // The SDK's own answers, asserted as the SDK gives them (D641): a DELETE in
  // stateless mode is accepted as a no-op (there is no session to end), and a
  // method the protocol has no use for is the SDK's 405 with its JSON-RPC body.
  const del = await handle(new Request(ENDPOINT, { method: "DELETE", headers: { authorization: "Bearer ok_live_good" } }));
  assert.equal(del.status, 200);
  const put = await handle(new Request(ENDPOINT, { method: "PUT", headers: { authorization: "Bearer ok_live_good" } }));
  assert.equal(put.status, 405);
});

test("D645: the per-key window — the boundary call is a 429 with Retry-After, and another key is untouched", async () => {
  const handle = handlerWith(resolveOk);
  for (let i = 0; i < MCP_RATE_LIMIT.max; i += 1) {
    const res = await post(handle, { authorization: "Bearer ok_live_good" }, { ...INITIALIZE, id: i + 1 });
    assert.equal(res.status, 200, `call ${i + 1} of ${MCP_RATE_LIMIT.max} was refused`);
  }
  const over = await post(handle, { authorization: "Bearer ok_live_good" }, INITIALIZE);
  assert.equal(over.status, 429);
  assert.equal(over.headers.get("retry-after"), String(MCP_RATE_LIMIT.windowMs / 1000));

  const other = handlerWith(async () => ({ keyId: "key_b", workspaceId: "ws_b", scope: "setup" }));
  const fresh = await post(other, { authorization: "Bearer anything" }, INITIALIZE);
  assert.equal(fresh.status, 200, "one key's window throttled another key");
});
