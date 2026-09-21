-- Active workspace (D717): the one explicit choice a person makes about which
-- of their organizations' workspaces their session reads. One row per user,
-- written only by the switcher (`apps/web/src/server/workspaces.ts`) from an
-- INSERT whose source row IS the membership check — nothing lands here unless
-- a `member` row joins the workspace's organization to that user — and read by
-- the session resolution (`server/session.ts`) as a PREFERENCE, never as an
-- authority: it is honoured only while the user is still a member of the
-- organization that owns the workspace, and the owner's first workspace
-- (D114/D120) is the answer otherwise. A person with one workspace never has a
-- row here, so nothing about the S3.1 signup shape changes for them.
--
-- user_id is a soft TEXT reference to the library-shaped "user" table (D112 —
-- no DDL of ours binds to better-auth's rows); workspace_id is an in-set
-- foreign key on 0004's rule, so a deleted workspace takes the choice with it
-- and the resolution falls back on its own.
CREATE TABLE IF NOT EXISTS active_workspaces
(
    user_id      TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
