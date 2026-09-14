-- API-key scope (S8.1, the MCP packet §1 / D644): which door a key opens.
-- 0012/0013 house style: a guarded ALTER, CHECK never enum, the DDL is the
-- authority — the web's `lib/mcp-types.ts` PARSES its vocabulary out of this
-- file's CHECK clause rather than restating it (the landing-fence idiom), so a
-- member added on one side without the other moving goes red.
--
-- Three members, and why exactly three. `ingest` is the credential an exporter
-- sends telemetry with — every key ever issued before this file is one, which
-- the DEFAULT makes true on upgrade with no backfill and no change for
-- ingest's callers. `read` is the credential an agent reads a workspace with
-- through the MCP endpoint (`apps/web/src/app/mcp/route.ts`), and `setup` is
-- `read` plus the one mutation that endpoint carries: minting an `ingest` key
-- (D666). Each door refuses the other scopes — ingest's lookup
-- (`internal/keystore/store.go`) carries `AND scope = 'ingest'`, the web's
-- resolve carries the two it admits — so a leaked exporter key cannot read the
-- workspace, and a leaked agent config cannot write into it (D644's reason,
-- stated once, here).
--
-- Guarded so the double-apply is a no-op: pass 2 emits ONE "column already
-- exists, skipping" NOTICE and nothing else, the whole clause — constraint
-- included — being skipped with the column. The constraint is NAMED so a later
-- migration widening the vocabulary can DROP it by name (0002's rule: a CHECK is
-- used precisely so widening later is an ordinary migration).
ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'ingest'
        CONSTRAINT api_keys_scope_check CHECK (scope IN ('ingest', 'read', 'setup'));
