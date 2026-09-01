-- Dashboards (S6.3, D424): workspace-scoped rows on the saved_views pattern (0002).
-- One table: a dashboard's widgets are an ORDERED JSONB array of
-- lib/dashboard-types.ts's DashboardWidget (position = index, pin = flag) — no
-- reader needs a per-widget row. Name is the identity within a workspace
-- (UNIQUE) and creating under a taken name is REFUSED, never upserted: an
-- upsert here would silently replace someone's widgets. CHECK never enum
-- (0002's rule); the workspace FK is in-set (D112) and a deleted workspace takes
-- its dashboards with it.
CREATE TABLE IF NOT EXISTS dashboards
(
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         TEXT NOT NULL CHECK (name <> ''),
    widgets      JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(widgets) = 'array'),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (workspace_id, name)
);
