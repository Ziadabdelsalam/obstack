-- Windowed per-key counts (D218/D260): the rows a TRUE rate is computed from.
--
-- The D100 health rows beside these are cumulative — lifetime totals plus the
-- "as of" the flush wrote them — which is an honest fact and the wrong one for
-- "how much is arriving right now". D218 refused to invent a per-minute figure
-- from cumulative counters; this table is what makes the figure computable
-- instead of estimated.
--
-- One row per key per minute. The grain is a minute because that is the unit
-- the product states ("/min"), and computing a stated unit from its own bucket
-- means the number needs no scaling assumption to be true.
--
-- Written by the same 5s metering flush as api_key_health, in the SAME
-- transaction and with the same add-never-set UPSERT (D162), so N replicas
-- flushing the same bucket concurrently is correct by construction — no leader,
-- no lease, no watermark, exactly as the cumulative rows work.
--
-- The table is bounded by construction rather than by a cleanup job: the same
-- flush deletes buckets older than the retention the flusher states (65
-- minutes, one hour of renderable history plus a margin), so the worst case is
-- keys × 65 rows and there is nothing to schedule, monitor or forget.
CREATE TABLE IF NOT EXISTS api_key_health_windows (
    key_id              TEXT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
    workspace_id        TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,

    -- The minute this bucket covers, truncated UTC — the boundary every replica
    -- lands on without agreeing on anything, the hour bucket's own pattern.
    bucket_start        TIMESTAMPTZ NOT NULL,

    accepted            BIGINT NOT NULL DEFAULT 0,
    dropped_decode      BIGINT NOT NULL DEFAULT 0,
    dropped_unsupported BIGINT NOT NULL DEFAULT 0,
    dropped_quota       BIGINT NOT NULL DEFAULT 0,

    PRIMARY KEY (key_id, bucket_start)
);

-- The read is "this workspace's buckets since T": a workspace-and-time index,
-- because the product asks for a rate per workspace and never for one key's
-- history alone.
CREATE INDEX IF NOT EXISTS api_key_health_windows_workspace_bucket_idx
    ON api_key_health_windows (workspace_id, bucket_start);
