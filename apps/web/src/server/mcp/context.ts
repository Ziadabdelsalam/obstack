import "server-only";
import type { McpKeyScope } from "@/lib/mcp-types";
import type { ScopedClickHouse } from "@/server/clickhouse";
import type { WorkspaceData } from "@/server/data";
import type { QueryRows } from "@/server/postgres";

/**
 * What every tool handler closes over (S8.1 D643): the workspace the bearer
 * key resolved to, and the SCOPED readers for it — nothing a tool argument can
 * name. `data` is the `WorkspaceData` facade (the four reads the pages take
 * through it), `ch` the `ScopedClickHouse` for the query modules that take one,
 * `query` the Postgres reader every M6 store binds `$1` on. The workspace is a
 * parameter and never ambient (D113); the route builds one of these per
 * request and the handlers never see the token.
 */
export interface McpContext {
  workspaceId: string;
  keyId: string;
  scope: McpKeyScope;
  data: WorkspaceData;
  ch: ScopedClickHouse;
  query: QueryRows;
  /** The one clock sample for the request (D50's `referenceNowMs`). */
  nowMs: number;
}

/**
 * The tool result shapes, both (D650): a success carries the contract object
 * VERBATIM as `structuredContent` and its JSON as the text a client without
 * structured-content support reads; a refusal is `isError` with a product
 * sentence — never a stack, never SQL, never a host, never a workspace id.
 */
export type McpToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function ok(structured: Record<string, unknown>): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

export function refusal(sentence: string): McpToolResult {
  return { content: [{ type: "text", text: sentence }], isError: true };
}
