-- API keys (D98). A key is the credential a client sends as
-- `Authorization: Bearer <token>`, and it names the workspace every record in
-- that request is written into. From M3 on Postgres is the one authority for
-- them: the OBSTACK_API_KEYS env map is deleted, so there is no second lookup
-- path a key could resolve through and no way for the two to disagree.
--
-- Only the SHA-256 of the full token is stored, never the token itself: a
-- database dump must not be a credential dump, which is what makes "shown once"
-- true rather than a screen. There is no per-row salt — the token carries 256
-- bits of CSPRNG output, so there is nothing to precompute against, and a KDF
-- would land on the ingest hot path. The UNIQUE on token_hash is the lookup
-- index ingest reads; it needs no second one.
--
-- prefix is display only — the first 12 characters — so a listed key is
-- recognisable in the UI without the secret being recoverable from the row.
--
-- workspace_id carries a real foreign key: workspaces is ours, in this same
-- set, and D112's no-FK rule bars references to the library-shaped tables, not
-- to our own. A deleted workspace takes its keys with it; they authorise writes
-- into a workspace that no longer exists.
--
-- There is deliberately no last_used_at: key liveness belongs to the health
-- rows (D100), and a column written on every authenticated request would turn a
-- cached read into a write on the ingest path.
CREATE TABLE IF NOT EXISTS api_keys
(
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    prefix       TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ DEFAULT now(),
    revoked_at   TIMESTAMPTZ
);

-- Listing a workspace's keys is the settings surface's whole query.
CREATE INDEX IF NOT EXISTS api_keys_workspace_id_idx ON api_keys (workspace_id);

-- The continuity row (D138). `ok_dev_local` is the dev credential the collector,
-- the compose harnesses and every signed M1/M2 evidence run send; it keeps
-- working because it is a row here now instead of an env entry. Its token_hash
-- is the D139 contract applied to that exact preimage —
-- SHA-256("ok_dev_local"), lowercase hex, no salt — and its prefix is the whole
-- token, honestly, because a credential published in a README has nothing to
-- hide behind a display prefix.
--
-- D115 is superseded on the record (D138): it kept ws_demo out of Postgres back
-- when keys resolved from env. Postgres is now the only key authority, so the
-- continuity key's workspace has to exist as a row. ws_demo stays
-- product-invisible by construction rather than by absence — session resolution
-- joins `member`, and no member row ever references org_demo, so no signed-in
-- user can resolve to it.
INSERT INTO workspaces (id, org_id) VALUES ('ws_demo', 'org_demo');

INSERT INTO api_keys (id, workspace_id, name, prefix, token_hash)
VALUES ('key_dev_local', 'ws_demo', 'dev local', 'ok_dev_local',
        '45880674fdc48bbcd49721bf6ac190e804836ca4fcd54c736c604153f4947e20');
