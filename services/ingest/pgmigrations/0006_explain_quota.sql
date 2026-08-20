-- The Explain quota (D226) and the run counter that spends it (D225).
--
-- The plan catalog stays the ONE definition of what a plan includes (D163): the
-- "20 free Explain runs" the landing page has been promising becomes a column
-- here, exactly as 50k/1M events did, so the panel's counter line, the settings
-- meter and the route's enforcement all divide the same two numbers and no
-- constant named 20 or 200 exists in TypeScript or in Go.

-- Nullable, filled, then made NOT NULL — rather than added with a DEFAULT. A
-- default would silently give the next plan row somebody adds a quota nobody
-- chose; this way the ALTER below fails on a catalog row whose quota was never
-- stated, which is a broken migration and should read as one. The UPDATE names
-- both seeded rows (0005 seeds exactly these two, and the runner applies a file
-- once), so a third row here leaves a NULL and the SET NOT NULL refuses.
--
-- The CHECK is the fail-closed end: 0 is a plan that includes no Explain runs
-- and the counter below refuses every one of them; a negative quota is not a
-- state the enforcement statement has an answer for, so it cannot be stored.
ALTER TABLE plans ADD COLUMN explain_quota INT;
UPDATE plans SET explain_quota = CASE id WHEN 'free' THEN 20 WHEN 'pro' THEN 200 END;
ALTER TABLE plans ALTER COLUMN explain_quota SET NOT NULL;
ALTER TABLE plans ADD CONSTRAINT plans_explain_quota_nonneg CHECK (explain_quota >= 0);

-- One row per workspace per billing month, and NOT an hour bucket like
-- usage_ledger (D225). The hour granularity there exists so the reporter can
-- re-send a closed bucket idempotently; an Explain run is a synchronous single
-- increment racing a cap, so buckets would buy nothing and split the number the
-- cap is compared against across rows.
--
-- period_start is the calendar month, UTC — the same window D163 defines for
-- event quota, spelled `(date_trunc('month', now() AT TIME ZONE 'UTC'))::date`.
-- It is a DATE and not a TIMESTAMPTZ on purpose: a date carries no instant to
-- re-anchor, so the D179 trap (a naked timestamp compared against a timestamptz
-- column silently taking the session's zone) has no way in here. The `now() AT
-- TIME ZONE 'UTC'` inside is what makes the month UTC's rather than the
-- session's, and it is the writer's single expression — apps/web's
-- server/explain/quota.ts states it once and both of its statements use it.
--
-- The statement of record — enforcement and increment in ONE atomic statement,
-- so two concurrent runs cannot both read "19 used" and both spend the 20th:
--
--   INSERT INTO explain_runs (workspace_id, period_start, used)
--        SELECT $1, (date_trunc('month', now() AT TIME ZONE 'UTC'))::date, 1
--         WHERE $2::int > 0
--   ON CONFLICT (workspace_id, period_start) DO UPDATE
--           SET used = explain_runs.used + 1, updated_at = now()
--         WHERE explain_runs.used < $2::int
--    RETURNING used
--
-- Zero rows returned = over quota = the run is refused and nothing was spent.
-- The `WHERE $2::int > 0` guard is what makes a zero-quota plan refuse its
-- FIRST run too: without it the INSERT arm has no cap to fail against and the
-- row would be created at used = 1. A single statement means no advisory lock
-- and therefore no TxQuery (D198 does not apply here — there is no read→write
-- to serialize).
CREATE TABLE IF NOT EXISTS explain_runs (
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    period_start DATE NOT NULL,                 -- calendar month, UTC: (date_trunc('month', now() AT TIME ZONE 'UTC'))::date
    used         INT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, period_start)
);
