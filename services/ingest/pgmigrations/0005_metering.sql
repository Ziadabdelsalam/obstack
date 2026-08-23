-- Metering, health, pricing overrides and the plan catalog (D99/D100/D108 as
-- ruled by D162/D163). This is the ledger of record: the number the billing tab
-- shows, the number the banner raises from, and the number the reporter sends to
-- Polar are all read from here, so there is one count and nothing to reconcile.
-- Polar is the billing rail and never the quota source — nothing in this file
-- has a Polar-owned meaning except the two id columns at the bottom, which are
-- receipts of a subscription rather than inputs to a decision.

-- The ledger is an hour bucket per workspace rather than a running total or a
-- row per event. The bucket is what makes the reporter idempotent with no
-- watermark and no send-log (D170): a closed hour is a final fact, so it can be
-- re-sent unconditionally and deduplicated server-side. period_start is the UTC
-- hour, truncated by the writer — `time.Now().UTC().Truncate(time.Hour)` — so
-- every replica lands on the same bucket boundary without agreeing on anything.
--
-- Spans and logs are counted separately because they are separately meaningful
-- to an operator, and summed for quota: the D163 definition, stated once, is
-- SUM(spans + logs) over period_start >= date_trunc('month', now() AT TIME ZONE
-- 'UTC') AT TIME ZONE 'UTC' compared against the plan's event_quota. The second
-- AT TIME ZONE is not decoration (D179): without it the boundary is the month
-- the server's session is in, which is the right answer only on a UTC host.
--
-- The UPSERT of record — the only shape any writer uses, correct under N
-- replicas by construction because it adds and never sets:
--
--   INSERT INTO usage_ledger (workspace_id, period_start, spans, logs)
--   VALUES ($1, $2, $3, $4)
--   ON CONFLICT (workspace_id, period_start) DO UPDATE
--     SET spans = usage_ledger.spans + EXCLUDED.spans,
--         logs = usage_ledger.logs + EXCLUDED.logs,
--         updated_at = now()
--
-- updated_at is the "as of" the product states: the freshest bucket write is
-- how stale the displayed usage is, which is bounded by the flush interval.
CREATE TABLE IF NOT EXISTS usage_ledger (
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    period_start TIMESTAMPTZ NOT NULL,          -- UTC hour bucket, truncated in Go: time.Now().UTC().Truncate(time.Hour)
    spans        BIGINT NOT NULL DEFAULT 0,
    logs         BIGINT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, period_start)
);

-- Per-key health (D100) — the liveness surface D138 refused to put on api_keys.
-- One row per key, written by the same flush as the ledger, so a key's last
-- event and its error counts are a read of a row rather than a scan of anything.
-- This is why no last_used_at column will ever join api_keys: the write lives
-- here, off the authenticated read path, batched.
--
-- The drop reasons are fixed columns and not JSONB or a row per reason: the
-- UPSERT-add above cannot be expressed safely over a JSONB map, and a new reason
-- is an ordinary migration, which is cheaper than making every writer merge
-- documents. dropped_write and panics are deliberately absent — the writer knows
-- the workspace but not the key that sent the record, so a write drop has no
-- honest home here; it stays a Prometheus counter for M3, and the Data & ingest
-- tab states its basis accordingly ("receive-path errors, as of …").
--
-- updated_at is that "as of". last_event_at is nullable because a key that has
-- authenticated but never carried an accepted record has no last event, and
-- "never" must not render as the epoch.
CREATE TABLE IF NOT EXISTS api_key_health (
    key_id              TEXT PRIMARY KEY REFERENCES api_keys (id) ON DELETE CASCADE,
    workspace_id        TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    accepted            BIGINT NOT NULL DEFAULT 0,
    dropped_decode      BIGINT NOT NULL DEFAULT 0,
    dropped_unsupported BIGINT NOT NULL DEFAULT 0,
    dropped_quota       BIGINT NOT NULL DEFAULT 0,
    last_event_at       TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The Data & ingest tab lists a workspace's keys with their health, and the
-- workspace's ingest-error count sums these rows — both read by workspace with
-- no key id in hand first. The workspace-state refresh does not read this table
-- at all: its two statements under lookupTimeout are the over-quota SELECT and
-- the overrides SELECT (D164), so nothing on the authenticated path waits here.
CREATE INDEX IF NOT EXISTS api_key_health_workspace_id_idx ON api_key_health (workspace_id);

-- Per-workspace pricing overrides (D108) on the D9 row shape: a model-name match
-- and the two per-million-token rates that replace the embedded table's for it.
-- Longest-prefix precedence is the application's (D167) — the row carries the
-- prefix, not a rank — and the layered table is built once per cache refresh, so
-- no span-path query ever reads this.
--
-- UNIQUE (workspace_id, match) is the identity: one rate pair per match per
-- workspace, so editing an override is an UPSERT and not a duplicate the
-- resolver would have to break a tie between.
--
-- The CHECK is what makes that identity mean one thing (D175). UNIQUE compares
-- the stored bytes, so `GPT-4o` would happily sit beside `gpt-4o` — and the
-- resolver lowercases every match before it compares, so those two rows are one
-- prefix with two rates and a tie nobody defined. Lowercase is therefore the
-- canonical form and the store is where it is enforced: the web app lowercases
-- on write, and this refuses the row if it ever stops. The Go side normalises
-- case rather than refusing it, which stays as defence against a hand-edited
-- database, not as the rule — a cache refresh cannot refuse the way boot can.
CREATE TABLE IF NOT EXISTS pricing_overrides (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    match          TEXT NOT NULL CHECK (match = lower(match)),
    input_per_mtok  DOUBLE PRECISION NOT NULL,
    output_per_mtok DOUBLE PRECISION NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, match)
);

-- The plan catalog lives here and only here (D163). Go reads it for the quota it
-- enforces and TypeScript reads it for the quota it displays; a constant in
-- either language would be the same number defined twice, which is the exact
-- divergence class S2.3 L3 was written about. retention_days is also the number
-- the retention sweep ENFORCES (D252, internal/retention): it reads each
-- workspace's current plan on a fixed cadence and deletes its telemetry past
-- that many days, with a 90-day table TTL behind it as the outer bound. The
-- surface can therefore state the entitlement plainly — the M4-era disclaimer
-- that enforcement had not landed came out with the sweep (D105).
--
-- The seed is a plain INSERT and not an UPSERT: the runner applies a file once,
-- so guarding it would be guarding against something that cannot happen. Prices
-- are NUMERIC and not float — money compared or summed in binary floating point
-- is a defect waiting for a rounding boundary.
CREATE TABLE IF NOT EXISTS plans (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    event_quota     BIGINT NOT NULL,
    retention_days  INT NOT NULL,
    price_usd_month NUMERIC(8,2) NOT NULL
);
INSERT INTO plans (id, name, event_quota, retention_days, price_usd_month)
VALUES ('free', 'Free', 50000, 7, 0), ('pro', 'Pro', 1000000, 30, 49);

-- A workspace's plan, absent = free (D163). No signup change and no backfill
-- follow from that: every resolution everywhere is the same left join,
-- `JOIN plans p ON p.id = COALESCE(wp.plan_id, 'free')`, so a workspace that has
-- never touched billing needs no row to be on a plan.
--
-- plan_id carries a real foreign key to the catalog above — both tables are ours
-- and in this set, so D112's no-FK rule does not apply — which makes a plan the
-- catalog does not define unrepresentable rather than merely unexpected.
--
-- The polar ids are receipts, nullable, and read by exactly one consumer: the
-- reporter, which sends usage only for workspaces that have one (D170), so
-- free-tier usage never leaves our ledger. Nothing reads them to decide quota.
CREATE TABLE IF NOT EXISTS workspace_plans (
    workspace_id          TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
    plan_id               TEXT NOT NULL REFERENCES plans (id),
    polar_customer_id     TEXT,
    polar_subscription_id TEXT,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
