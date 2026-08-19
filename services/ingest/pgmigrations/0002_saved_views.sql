-- Saved views (D30/D116), workspace-scoped rows replacing the browser store
-- outright. The identity contract from D47 carries over unchanged: a trimmed
-- name is unique per surface, and saving over an existing name is an UPSERT on
-- that unique key rather than a second row the operator has to disambiguate.
--
-- filters is the URL shape the surface already speaks — Record<string,string>
-- minus the page param — so a saved view is replayable by assignment into the
-- query string, with no second serialisation to keep in step.
--
-- surface is a CHECK and never a Postgres enum type: widening a CHECK is an
-- ordinary migration, where widening an enum is a type-level change that locks
-- against every reader of the column.
--
-- The workspace_id foreign key is in-set and therefore required — D112's no-FK
-- rule bars references to library-shaped tables, not to our own. A deleted
-- workspace's views are gone with it; they mean nothing without it.
CREATE TABLE IF NOT EXISTS saved_views
(
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    surface      TEXT NOT NULL CHECK (surface IN ('traces', 'logs')),
    name         TEXT NOT NULL,
    filters      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (workspace_id, surface, name)
);
