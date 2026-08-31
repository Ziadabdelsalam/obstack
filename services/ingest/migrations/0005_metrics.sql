-- Metrics (D363 packet, ruled 2026-08-31): ONE wide data-points table for all
-- three OTLP temperaments (gauge/sum/histogram), house-style (the `spans`
-- precedent) — one batcher, one INSERT, one MV chain rather than per-type
-- tables that triple the write path for zero query benefit.
--
-- Metric identity is (name, series_hash), series_hash = sipHash64(name ‖
-- service ‖ sorted point-attribute KV pairs), computed at ingest by
-- internal/mapping (D8: computed at ingest, never at query time). `type` is
-- constant per series by construction, which is what makes anyLast(...) /
-- per-type columns in the rollups below exact rather than approximate.
--
-- Temporality is normalized to DELTA at ingest (per-series cache in mapping);
-- every downstream layer is therefore a pure sum() — see packet §1.
--
-- Raw is an implementation buffer (MV source + re-derivation + debugging), NOT
-- a product promise: flat 3-day TTL, no plan-sweep membership (Q4/packet §4).
-- Every contract read is served by the rollups below.
--
-- D373 amendment (2026-09-01, measured on clickhouse-server:26.3.17.110):
-- anyLast(Map(LowCardinality(String), String)) returns Map(String, String)
-- (the LowCardinality wrapper is stripped), and a SimpleAggregateFunction
-- column's storage type must equal the function's measured return type — the
-- packet's original `attributes SimpleAggregateFunction(anyLast,
-- Map(LowCardinality(String), String))` pairing is rejected (code 36).
-- Rollup/series `attributes` columns below use Map(String, String) instead;
-- the raw table keeps Map(LowCardinality(String), String) (where the
-- dictionary earns its keep); the insert coerces LC->String losslessly.
-- Attributes are constant per series_hash, so anyLast is exact either way.
-- (D375 below further changes what the MV SELECTs feed into anyLast.)
--
-- D375 amendment (2026-09-01, E-T2 reviewer escalation, packet defect):
-- rollup/series `attributes` is the MERGED label set, not point attributes
-- alone -- each MV SELECT computes anyLast(mapUpdate(resource_attributes,
-- attributes)), point attrs winning on key collision, so resource-borne
-- groupBy keys (e.g. k8s.pod.name) are queryable without a raw-table join.
-- Raw table is untouched (both maps kept, full OTLP fidelity); the
-- SimpleAggregateFunction(anyLast, Map(String, String)) storage type is
-- unchanged -- mapUpdate's output coerces the same way per D373.
CREATE TABLE IF NOT EXISTS obstack.metric_points
(
    workspace_id        LowCardinality(String),
    name                LowCardinality(String),
    type                Enum8('gauge' = 1, 'sum' = 2, 'histogram' = 3),
    unit                LowCardinality(String),
    service             LowCardinality(String),
    series_hash         UInt64,                  -- computed by internal/mapping (D8)
    timestamp           DateTime64(9, 'UTC'),
    value               Float64,                 -- gauge value | DELTA for sums | 0 for histograms
    is_monotonic        UInt8,
    bounds              Array(Float64),          -- histograms only; len = len(bucket_counts) - 1
    bucket_counts       Array(UInt64),           -- delta-normalized
    h_sum               Float64,
    h_count             UInt64,
    h_min               Float64,
    h_max               Float64,
    attributes          Map(LowCardinality(String), String),
    resource_attributes Map(LowCardinality(String), String)
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (workspace_id, name, series_hash, timestamp)
TTL toDateTime(timestamp) + INTERVAL 3 DAY;

-- 1m rollup: serves the 1h@1m / 6h@5m / 24h@15m contract widths via query-time
-- toStartOfInterval + -Merge over this table (the overview.ts idiom, packet
-- §3). QUERY RULE (binding, carried over from trace_summaries verbatim):
-- always GROUP BY the series key + bucket with the matching combinators;
-- never FINAL, never a bare SELECT — unmerged parts would under-report.
-- 90-day outer TTL applied at birth (the 0004 end-state, no separate MODIFY
-- migration); joins the retention.go per-plan sweep in place (T5).
CREATE TABLE IF NOT EXISTS obstack.metric_points_1m
(
    workspace_id  LowCardinality(String),
    name          LowCardinality(String),
    type          Enum8('gauge' = 1, 'sum' = 2, 'histogram' = 3),
    unit          LowCardinality(String),
    service       LowCardinality(String),
    series_hash   UInt64,
    bucket        DateTime('UTC'),
    attributes    SimpleAggregateFunction(anyLast, Map(String, String)), -- constant per series: exact
    sum_delta     SimpleAggregateFunction(sum, Float64),      -- sum agg; rate = sum_delta / bucket-seconds
    gauge_min     SimpleAggregateFunction(min, Float64),
    gauge_max     SimpleAggregateFunction(max, Float64),
    gauge_avg     AggregateFunction(avg, Float64),
    gauge_last    AggregateFunction(argMax, Float64, DateTime64(9, 'UTC')),
    bounds        SimpleAggregateFunction(anyLast, Array(Float64)),
    hist_counts   AggregateFunction(sumForEach, Array(UInt64)),
    h_sum         SimpleAggregateFunction(sum, Float64),
    h_count       SimpleAggregateFunction(sum, UInt64),
    h_min         SimpleAggregateFunction(min, Float64),
    h_max         SimpleAggregateFunction(max, Float64),
    max_seen_date SimpleAggregateFunction(max, Date)
)
ENGINE = AggregatingMergeTree
ORDER BY (workspace_id, name, series_hash, bucket)
TTL max_seen_date + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS obstack.metric_points_1m_mv TO obstack.metric_points_1m AS
SELECT workspace_id, name, type, unit, service, series_hash,
       toStartOfMinute(timestamp) AS bucket,
       anyLast(mapUpdate(resource_attributes, attributes)) AS attributes,
       sum(value) AS sum_delta,
       min(value) AS gauge_min, max(value) AS gauge_max,
       avgState(value) AS gauge_avg, argMaxState(value, timestamp) AS gauge_last,
       anyLast(bounds) AS bounds, sumForEachState(bucket_counts) AS hist_counts,
       sum(h_sum) AS h_sum, sum(h_count) AS h_count, min(h_min) AS h_min, max(h_max) AS h_max,
       max(toDate(timestamp)) AS max_seen_date
FROM obstack.metric_points
GROUP BY workspace_id, name, type, unit, service, series_hash, toStartOfMinute(timestamp);

-- 1h rollup: identical shape with toStartOfHour, serving M6's known 7d/30d SLO
-- windows (packet §3) — not speculative, a stated future consumer.
CREATE TABLE IF NOT EXISTS obstack.metric_points_1h
(
    workspace_id  LowCardinality(String),
    name          LowCardinality(String),
    type          Enum8('gauge' = 1, 'sum' = 2, 'histogram' = 3),
    unit          LowCardinality(String),
    service       LowCardinality(String),
    series_hash   UInt64,
    bucket        DateTime('UTC'),
    attributes    SimpleAggregateFunction(anyLast, Map(String, String)),
    sum_delta     SimpleAggregateFunction(sum, Float64),
    gauge_min     SimpleAggregateFunction(min, Float64),
    gauge_max     SimpleAggregateFunction(max, Float64),
    gauge_avg     AggregateFunction(avg, Float64),
    gauge_last    AggregateFunction(argMax, Float64, DateTime64(9, 'UTC')),
    bounds        SimpleAggregateFunction(anyLast, Array(Float64)),
    hist_counts   AggregateFunction(sumForEach, Array(UInt64)),
    h_sum         SimpleAggregateFunction(sum, Float64),
    h_count       SimpleAggregateFunction(sum, UInt64),
    h_min         SimpleAggregateFunction(min, Float64),
    h_max         SimpleAggregateFunction(max, Float64),
    max_seen_date SimpleAggregateFunction(max, Date)
)
ENGINE = AggregatingMergeTree
ORDER BY (workspace_id, name, series_hash, bucket)
TTL max_seen_date + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS obstack.metric_points_1h_mv TO obstack.metric_points_1h AS
SELECT workspace_id, name, type, unit, service, series_hash,
       toStartOfHour(timestamp) AS bucket,
       anyLast(mapUpdate(resource_attributes, attributes)) AS attributes,
       sum(value) AS sum_delta,
       min(value) AS gauge_min, max(value) AS gauge_max,
       avgState(value) AS gauge_avg, argMaxState(value, timestamp) AS gauge_last,
       anyLast(bounds) AS bounds, sumForEachState(bucket_counts) AS hist_counts,
       sum(h_sum) AS h_sum, sum(h_count) AS h_count, min(h_min) AS h_min, max(h_max) AS h_max,
       max(toDate(timestamp)) AS max_seen_date
FROM obstack.metric_points
GROUP BY workspace_id, name, type, unit, service, series_hash, toStartOfHour(timestamp);

-- metric_series earns its MV three times over (packet §3): it IS
-- listMetricCatalog (no raw scan), the 25k-active-series cardinality
-- reconciliation source (Q2), and the attrKeys source. Swept so a workspace's
-- catalog forgets series older than its plan's retention — the catalog
-- telling the truth is part of D13.
CREATE TABLE IF NOT EXISTS obstack.metric_series
(
    workspace_id LowCardinality(String),
    name         LowCardinality(String),
    series_hash  UInt64,
    type         Enum8('gauge' = 1, 'sum' = 2, 'histogram' = 3),
    unit         LowCardinality(String),
    service      LowCardinality(String),
    attributes   SimpleAggregateFunction(anyLast, Map(String, String)),
    first_seen   SimpleAggregateFunction(min, DateTime('UTC')),
    last_seen    SimpleAggregateFunction(max, DateTime('UTC'))
)
ENGINE = AggregatingMergeTree
ORDER BY (workspace_id, name, series_hash)
TTL last_seen + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS obstack.metric_series_mv TO obstack.metric_series AS
SELECT workspace_id, name, series_hash, type, unit, service,
       anyLast(mapUpdate(resource_attributes, attributes)) AS attributes,
       min(toDateTime(timestamp)) AS first_seen,
       max(toDateTime(timestamp)) AS last_seen
FROM obstack.metric_points
GROUP BY workspace_id, name, series_hash, type, unit, service;
