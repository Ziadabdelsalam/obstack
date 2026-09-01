-- Alerts (S7.1, the alerts-engine packet §4): rules CRUD and delivery on the
-- 0009 house style. Three tables, all workspace-scoped (D7/D11), TEXT pks,
-- CHECK never enum, UNIQUE (workspace_id, name) where the row has a name.
--
-- notification_channels holds where an event goes. target is the channel's
-- own secret (a Slack webhook URL IS a credential, D487) and this migration
-- stores it plaintext (the api_keys posture precedent) — masking to
-- scheme+host+last-4 is a read-path concern, not a column constraint; no read
-- path returns it whole.
CREATE TABLE IF NOT EXISTS notification_channels
(
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         TEXT NOT NULL CHECK (name <> ''),
    kind         TEXT NOT NULL CHECK (kind IN ('webhook', 'slack_webhook')),
    target       TEXT NOT NULL CHECK (target <> ''),
    enabled      BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (workspace_id, name)
);

-- alert_rules is the evaluator's claim target (D477/D478): condition is
-- structured JSONB (D481, the TS/Go parity fixture is the schema's second
-- copy, not this one), state is the D484 machine, next_eval_at is what the
-- claim query orders and stamps forward on every tick — enabled or not, so a
-- disabled rule re-enabled later does not fire on a stale timestamp.
--
-- channel_id is ON DELETE RESTRICT, not CASCADE: this is the one
-- cross-reference in the set that is NOT a workspace-owns-row edge, and a
-- cascading delete here would silently disarm a rule (delete a channel, the
-- rule that pointed at it vanishes with it, nobody notified of either). The
-- action layer also refuses the delete while a rule references the channel
-- (packet §4) — this FK is the refuse-never-cascade backstop underneath it.
CREATE TABLE IF NOT EXISTS alert_rules
(
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name              TEXT NOT NULL CHECK (name <> ''),
    condition         JSONB NOT NULL CHECK (jsonb_typeof(condition) = 'object'),
    severity          TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    channel_id        TEXT NOT NULL REFERENCES notification_channels (id) ON DELETE RESTRICT,
    enabled           BOOLEAN NOT NULL DEFAULT true,
    runbook           TEXT NULL,
    state             TEXT NOT NULL CHECK (state IN ('ok', 'firing')) DEFAULT 'ok',
    last_triggered_at TIMESTAMPTZ NULL,
    next_eval_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (workspace_id, name)
);

-- The claim query's own shape (D478): `WHERE enabled AND next_eval_at <=
-- now()`. Partial on enabled so a workspace's disabled rules never enter the
-- index at all, rather than being carried and filtered on every tick.
CREATE INDEX IF NOT EXISTS alert_rules_next_eval_at_idx
    ON alert_rules (next_eval_at) WHERE enabled;

-- alert_events is the feed: written pending by the evaluator (a rule
-- transition, D484) or by sendTestNotification (D488/D491), delivered by the
-- deliverer ticker (D490) which owns the delivery/attempts columns from here
-- on. rule_id is NULLABLE — a test notification is a rule-less event — and
-- CASCADEs with its rule since an event has no meaning once its rule is gone.
-- channel_id is captured AT EMIT TIME (D491: a later rule edit never
-- retargets an old event) and SET NULL on delete, in which case a still-
-- pending event has nowhere to go and marks failed (deliverer's own logic,
-- not this migration's).
CREATE TABLE IF NOT EXISTS alert_events
(
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    rule_id      TEXT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,
    channel_id   TEXT NULL REFERENCES notification_channels (id) ON DELETE SET NULL,
    severity     TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    title        TEXT NOT NULL,
    detail       TEXT NOT NULL DEFAULT '',
    link         TEXT NULL,
    delivery     TEXT NOT NULL CHECK (delivery IN ('pending', 'delivered', 'failed')) DEFAULT 'pending',
    attempts     SMALLINT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The feed's own read: newest-first, per workspace.
CREATE INDEX IF NOT EXISTS alert_events_workspace_id_created_at_idx
    ON alert_events (workspace_id, created_at DESC);
