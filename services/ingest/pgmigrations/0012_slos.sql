-- SLOs (S7.3, the SLOs packet §3 / D513): the objectives /app/slos renders,
-- CRUD'd by the web tier and EVALUATED by the ingest binary's second claim on
-- the S7.1 ticker (D510) — which owns the measurement columns from here on.
-- 0009/0010/0011 house style: TEXT pk, workspace FK CASCADE (D7/D11), CHECK
-- never enum, UNIQUE (workspace_id, name), every bound in the DDL.
--
-- indicator is structured JSONB (D517, the alert_rules.condition pattern): the
-- TS/Go parity fixture is the schema's second copy, not this one. target is
-- NUMERIC(6,3) and strictly inside (0, 100): a 100% objective has no error
-- budget to burn, a 0% one is not an objective. eval_window is the D507
-- vocabulary as a string (the same "7d"/"30d" the two languages carry —
-- single-sourced across three readers); it is not called `window` because
-- that word is reserved in SQL and every statement would have to quote it.
--
-- channel_id is NULLABLE (D511): an SLO with no channel is computed and
-- rendered but never notifies. Where set it is ON DELETE RESTRICT, the 0010
-- reasoning verbatim — a cascade would silently disarm an objective's paging
-- — and the action layer refuses the delete first with the channel named.
--
-- The measurement columns (status, current_pct, budget_burned_pct,
-- good_count, total_count, evaluated_at, last_transition_at) are the
-- evaluator's alone. They start in the honest state: no-data with NULL
-- numbers (D508) — a card that has never been evaluated says so, it does not
-- say 100%. good_count and total_count are set together or not at all.
CREATE TABLE IF NOT EXISTS slos
(
    id                 TEXT PRIMARY KEY,
    workspace_id       TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name               TEXT NOT NULL CHECK (name <> ''),
    indicator          JSONB NOT NULL CHECK (jsonb_typeof(indicator) = 'object'),
    target             NUMERIC(6,3) NOT NULL CHECK (target > 0 AND target < 100),
    eval_window        TEXT NOT NULL CHECK (eval_window IN ('7d', '30d')),
    channel_id         TEXT NULL REFERENCES notification_channels (id) ON DELETE RESTRICT,
    enabled            BOOLEAN NOT NULL DEFAULT true,
    status             TEXT NOT NULL CHECK (status IN ('healthy', 'at-risk', 'breached', 'no-data')) DEFAULT 'no-data',
    current_pct        DOUBLE PRECISION NULL,
    budget_burned_pct  DOUBLE PRECISION NULL,
    good_count         BIGINT NULL,
    total_count        BIGINT NULL,
    evaluated_at       TIMESTAMPTZ NULL,
    last_transition_at TIMESTAMPTZ NULL,
    next_eval_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (workspace_id, name),
    CHECK ((good_count IS NULL) = (total_count IS NULL))
);

-- The claim query's own shape (D510, the D478 mechanism): `WHERE enabled AND
-- next_eval_at <= now()`. Partial on enabled, as alert_rules' is.
CREATE INDEX IF NOT EXISTS slos_next_eval_at_idx
    ON slos (next_eval_at) WHERE enabled;

-- SLO transitions ride the S7.1 pipeline (D511/D513): an alert_events row
-- with slo_id set and rule_id NULL, delivered by the same deliverer. This is
-- the Postgres track's first ALTER; the column is guarded by IF NOT EXISTS so
-- the raw double-apply stays a no-op, and CASCADEs with its SLO for the reason
-- rule events cascade with their rule — an event has no meaning once the
-- objective it was about is gone.
ALTER TABLE alert_events
    ADD COLUMN IF NOT EXISTS slo_id TEXT NULL REFERENCES slos (id) ON DELETE CASCADE;

-- The cascade's own lookup, and the feed's join back to the SLO's name.
CREATE INDEX IF NOT EXISTS alert_events_slo_id_idx
    ON alert_events (slo_id) WHERE slo_id IS NOT NULL;

-- One producer per event: a row is a rule's transition, an SLO's transition,
-- or (both NULL) a test notification (D491) — never two at once. Postgres has
-- no ADD CONSTRAINT IF NOT EXISTS, so the guard is an existence check on
-- pg_constraint scoped to THIS schema's table (regclass resolves through the
-- search_path, which is how the isolated test schemas stay isolated).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'alert_events_one_producer_check'
           AND conrelid = 'alert_events'::regclass
    ) THEN
        ALTER TABLE alert_events
            ADD CONSTRAINT alert_events_one_producer_check CHECK (rule_id IS NULL OR slo_id IS NULL);
    END IF;
END $$;
