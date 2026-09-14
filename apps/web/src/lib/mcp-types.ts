/**
 * The MCP contract's client-safe half (S8.1 packet §0) — S8.1 T1 lands the
 * key-scope vocabulary; T2 adds the tool registry, the prompt text and the
 * endpoint constants to this same file.
 *
 * CLIENT-SAFE by the `metrics-types.ts` rule (D366) and, like `change-types.ts`,
 * `slo-types.ts` and `incident-types.ts`, with ZERO imports: the settings
 * picker (a client component), the server's key module, the MCP route and the
 * docs page all read these constants, and a client component cannot import a
 * `server-only` module for a type alone (S1.5/D10). The enforcement is machine
 * — `mcp-types.test.ts` asserts `/^import /m.test(source) === false` over this
 * file's own bytes.
 *
 * The scope vocabulary is NOT its own authority (D644): the CHECK clause of
 * `services/ingest/pgmigrations/0014_api_key_scope.sql` is, and the test PARSES
 * the members and the DEFAULT out of that file (the `landing-fence.test.ts`
 * idiom) rather than restating them. A member added on one side without the
 * other moving goes red.
 */

/** Which door a key opens (D644): `ingest` sends telemetry; `read` reads the workspace through MCP; `setup` is `read` plus minting `ingest` keys through MCP (D666). */
export type ApiKeyScope = "ingest" | "read" | "setup";

/** The runtime list, in the DDL's order. */
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ["ingest", "read", "setup"];

/** What a key is when nobody says (the column's DEFAULT — every key issued before 0014 is one). */
export const DEFAULT_API_KEY_SCOPE: ApiKeyScope = "ingest";

/** The two scopes the MCP endpoint lets in (D642); only `setup` unlocks the mint (D666). */
export type McpKeyScope = "read" | "setup";
export const MCP_ADMITTED_SCOPES: readonly McpKeyScope[] = ["read", "setup"];

/** One line per scope for the picker and the docs — the same words in both places. */
export const API_KEY_SCOPE_LABELS: Readonly<Record<ApiKeyScope, string>> = {
  ingest: "ingest — sends telemetry (exporters, the collector, the SDKs)",
  read: "read — an agent reads this workspace through MCP",
  setup: "setup — read, plus minting ingest keys through MCP",
};
