-- Incidents (S7.4, the incidents packet §2 / D524): the per-workspace objects
-- /app/incidents lists and /app/incidents/[id] renders — opened by a person by
-- hand or by PROMOTING an alert event (D526), and closed by a person.
-- 0009/0010/0011/0012 house style: TEXT pk (`inc_` + 16 hex, the
-- rule_/chan_/evt_/slo_/chg_ idiom, app-generated), workspace FK CASCADE
-- (D7/D11), CHECK never enum, and every length CHECKed HERE — the DDL is the
-- authority (the S7.1 T5 ruling); the handler refuses first, with the field
-- named, so a constraint never surfaces as a 500. created_at/updated_at are
-- set by hand: no trigger exists anywhere in this set.
--
-- D525: severity is the ALERT vocabulary VERBATIM, three members incl 'info',
-- because severity is not invented here: promotion copies an
-- alert_events.severity, whose CHECK is these same three (0010), and any
-- narrower target forces a mapping that overstates an info event or
-- understates a critical one — D13 forbids both. It carries no DEFAULT: a
-- manual create must SEND one. status is the two states the product has, and a
-- CHECK is used precisely so widening later is an ordinary migration
-- (0002_saved_views.sql's rule); a third state invented before a product need
-- names it is inventing product.
--
-- There is deliberately NO rca and NO rca_generated_at column (D555). The
-- Explain rail does not store its answers, and "RCA rides the rail unchanged"
-- is taken literally — so this table, which retention never sweeps, holds
-- ONLY what a person typed. Machine-derived text quoting telemetry that IS
-- swept is the one thing the never-swept argument would not have covered, and
-- it is absent rather than deferred. Do not add one back for symmetry with a
-- panel.
--
-- There is deliberately NO UNIQUE (workspace_id, title) (D524), unlike the
-- UNIQUE (workspace_id, name) the definition tables in 0009/0010/0012 each
-- carry: two real outages share a title, and the from-alert promotion COPIES
-- the alert's title, so a recurring rule mints the same string by
-- construction. The store therefore carries no duplicate-name refusal and no
-- 23505 branch AT ALL — the absence is stated in both files so nobody adds a
-- dead one back for house-style symmetry.
--
-- There is NO duration column: the mock's "22m" is a display string, and a
-- stored duration is a third copy of two columns that can disagree. The time
-- range is the two columns started_at/ended_at, and neither is named `window`
-- — that word is reserved in Postgres and every statement would have to quote
-- it (0012 ships eval_window and says so).
--
-- The two table-level CHECKs are the both-or-neither idiom (0011:42, 0012:47):
-- they make "ongoing with an end" and "resolved with no end" unrepresentable
-- rather than merely unexpected, and an incident cannot end before it started.
--
-- opened_from_event_id is ON DELETE SET NULL, and it cannot be anything else
-- (D526). The retention sweep batch-DELETEs alert_events per workspace down to
-- the plan window (internal/retention/retention.go:162-163, ctid batches of
-- 5000). Under the Postgres DEFAULT, NO ACTION — or under RESTRICT — that
-- DELETE raises 23503 the moment one swept event has an incident pointing at
-- it, and the sweeper logs, counts sweepFailures, skips the table and retries
-- the IDENTICAL failing statement every interval: that workspace's sweep is
-- wedged forever. CASCADE goes the other way and deletes an operator's
-- postmortem because their alert aged out. SET NULL is the only action that
-- neither wedges nor destroys, and 0011_change_events.sql's key_id is the
-- precedent — "the event happened, and deleting the key that reported it is
-- not evidence it did not".
--
-- But that SET NULL fires from a HUMAN revoke, and THIS one fires from the
-- sweeper on a 7-day clock, so the pointer nulling must not erase the FACT of
-- the promotion: origin is set to 'alert' at promote time and never rewritten,
-- the surface renders the "from an alert" mark off origin and NEVER off the
-- nullable pointer, and a nulled pointer reads as "promoted from an alert that
-- has since aged out" — never as manual.
--
-- incidents is deliberately NOT swept by retention (D528). retention.go:150-153
-- scopes that leg to "the product tables that grow by the workspace's own
-- activity" — rows the workspace's MACHINES produce at machine rate, holding
-- observations a machine could re-derive. An incident is neither telemetry nor
-- a definition: it is created only by a person, one at a time, with no ingest
-- endpoint, and its title, summary and impact are the only copy of something
-- no machine can regenerate. Sweeping it would delete an operator's postmortem
-- seven days later on Free, with no export and no undo. The bound is instead
-- the per-workspace cap (D529: MAX_INCIDENTS_PER_WORKSPACE = 500, counted
-- under the workspace lock on BOTH insert paths), plus the length CHECKs
-- below, plus the workspace cascade.
--
-- This file adds no constraint to an EXISTING table, so unlike 0012 it needs no
-- DO $$ ... pg_constraint ... regclass ... $$ existence guard: every CHECK is
-- inline in a CREATE TABLE IF NOT EXISTS, and a raw double-apply is a no-op by
-- construction.
CREATE TABLE IF NOT EXISTS incidents
(
    id                   TEXT PRIMARY KEY,
    workspace_id         TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    title                TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    status               TEXT NOT NULL CHECK (status IN ('ongoing', 'resolved')) DEFAULT 'ongoing',
    severity             TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    origin               TEXT NOT NULL CHECK (origin IN ('manual', 'alert')) DEFAULT 'manual',
    impact               TEXT NOT NULL DEFAULT '' CHECK (char_length(impact) <= 500),
    summary              TEXT NOT NULL DEFAULT '' CHECK (char_length(summary) <= 2000),
    started_at           TIMESTAMPTZ NOT NULL,
    ended_at             TIMESTAMPTZ NULL,
    opened_from_event_id TEXT NULL REFERENCES alert_events (id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK ((status = 'resolved') = (ended_at IS NOT NULL)),
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- The list's own read: newest-first by the incident's OWN start, per
-- workspace. There is no cursor to serve — the cap IS the bound (D529), so
-- every row the workspace holds is reachable in one read.
CREATE INDEX IF NOT EXISTS incidents_workspace_id_started_at_idx
    ON incidents (workspace_id, started_at DESC);

-- At most one incident per promoted event (D526) — a second promotion of the
-- same event returns the ORIGINAL rather than minting a twin. Partial because
-- NULL is the common case: a manually opened incident points at nothing, and
-- rows without a pointer are never deduplicated against each other.
--
-- This index is deliberately SINGLE-COLUMN, dropping the workspace_id prefix
-- every other per-workspace index in this set leads with, BECAUSE it is also
-- the FK's own SET NULL lookup index. The FK is on one column, so the RI
-- trigger's predicate is `opened_from_event_id = $1` ALONE, with no workspace
-- in it, and retention pays that lookup once per row of a 5000-row ctid batch.
-- A (workspace_id, ...) leading index cannot SEEK on that predicate: the
-- column is not the leading one, so Postgres can only apply it as a
-- non-boundary Index Cond and walk the WHOLE index. Measured on 50k rows,
-- and stating the condition so the number reproduces: forced to that index
-- with `SET enable_seqscan = off`, 194 buffers per lookup against this
-- index's 3, and the gap grows with the table. Left free the planner does not
-- pick it at all — it seq-scans, 358 buffers — so the real cost is worse than
-- the forced figure, not better. Same reasoning as
-- `alert_events_slo_id_idx ... WHERE slo_id IS NOT NULL`, "the cascade's own
-- lookup", at 0012:64-66. The partial predicate is no obstacle to serving it:
-- `= $1` is strict and so implies `IS NOT NULL`.
CREATE UNIQUE INDEX IF NOT EXISTS incidents_opened_from_event_id_idx
    ON incidents (opened_from_event_id) WHERE opened_from_event_id IS NOT NULL;
