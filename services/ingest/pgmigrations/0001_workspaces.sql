-- Workspaces (D95). An org owns 1..N workspaces and signup auto-creates one of
-- each, so a workspace is the identity every product surface scopes to — the id
-- the telemetry queries bind and the saved views below hang off.
--
-- org_id is a soft TEXT reference and deliberately carries no foreign key
-- (D112): the org rows are better-auth's, captured into this same set but
-- library-shaped, and DDL of ours that bound to them would make an upstream
-- rename our outage. Integrity is the signup transaction's property instead —
-- an org without its workspace is a failed signup, not a row to clean up.
CREATE TABLE IF NOT EXISTS workspaces
(
    id         TEXT PRIMARY KEY,
    org_id     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The active workspace is the org's first (D114 — no active_workspace column and
-- no switcher, so the resolution is `ORDER BY created_at, id LIMIT 1`). That
-- lookup runs on every live-mode request, and this is the index it reads.
CREATE INDEX IF NOT EXISTS workspaces_org_id_created_at_idx
    ON workspaces (org_id, created_at, id);
