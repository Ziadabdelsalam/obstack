-- Change events (S7.2, the changes-feed packet §3 / D500): the rows the
-- /app/changes timeline renders and the services deploys panel reads, written
-- by POST /v1/changes (D493) under api-key auth and swept by the retention
-- pass (D501). 0009/0010 house style: TEXT pk, workspace FK CASCADE (D7/D11),
-- CHECK never enum, and every length CHECKed HERE — the DDL is the authority
-- (the S7.1 T5 ruling); the handler refuses first, with the field named, so a
-- constraint never surfaces as a 500.
--
-- key_id is provenance — which credential posted the row — for ops and a
-- future audit, never rendered in v1. SET NULL, not CASCADE: the event
-- happened, and deleting the key that reported it is not evidence it did not.
--
-- external_id is the client's idempotency handle (D496): a retried CI step
-- posts the same one and gets the ORIGINAL row back, first write wins. The
-- UNIQUE is partial and per workspace — two workspaces may share the string,
-- and rows without one are never deduplicated.
--
-- at is the event's own time (client-supplied, or the server's now() when
-- absent); created_at is receipt. The feed orders by at, so a backfilled
-- event sorts where it happened, and retention reads at (D501) — an event
-- older than the plan window is outside it however recently it arrived.
--
-- link is two columns that are set together or not at all (D499): a label
-- without a target or a target without a label is not a link.
CREATE TABLE IF NOT EXISTS change_events
(
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    key_id       TEXT NULL REFERENCES api_keys (id) ON DELETE SET NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('deploy', 'config', 'scale', 'secret', 'flag', 'infra')),
    title        TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    detail       TEXT NOT NULL DEFAULT '' CHECK (char_length(detail) <= 2000),
    who          TEXT NOT NULL DEFAULT '' CHECK (char_length(who) <= 120),
    service      TEXT NULL CHECK (char_length(service) <= 120),
    ref          TEXT NULL CHECK (char_length(ref) <= 128),
    source       TEXT NULL CHECK (char_length(source) <= 60),
    link_label   TEXT NULL CHECK (char_length(link_label) <= 60),
    link_href    TEXT NULL CHECK (char_length(link_href) <= 2048),
    external_id  TEXT NULL CHECK (char_length(external_id) <= 200),
    at           TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((link_label IS NULL) = (link_href IS NULL))
);

-- The feed's own read: newest-first by the event's time, per workspace.
CREATE INDEX IF NOT EXISTS change_events_workspace_id_at_idx
    ON change_events (workspace_id, at DESC);

-- The deploys panel's read (D503): one service's deploys, newest-first. Partial
-- on kind — the panel never asks for anything else, and the index stays the
-- size of the deploys alone.
CREATE INDEX IF NOT EXISTS change_events_deploys_idx
    ON change_events (workspace_id, service, at DESC) WHERE kind = 'deploy';

-- D496: the dedupe key, per workspace, only where the client supplied one.
CREATE UNIQUE INDEX IF NOT EXISTS change_events_workspace_id_external_id_idx
    ON change_events (workspace_id, external_id) WHERE external_id IS NOT NULL;
