-- Logs (D7). trace_id sits in the ordering key so the trace-detail logs rail is
-- a single range read; trace_id is the empty string for logs with no span
-- context. The pod bloom filter is what the M2 "nearby logs" join will use.
CREATE TABLE IF NOT EXISTS obstack.logs
(
    workspace_id        LowCardinality(String),
    timestamp           DateTime64(9, 'UTC'),
    trace_id            String,
    span_id             String,
    severity_number     UInt8,
    severity_text       LowCardinality(String),
    body                String CODEC(ZSTD(3)),
    service             LowCardinality(String),

    k8s_namespace       LowCardinality(String),
    k8s_pod             LowCardinality(String),
    k8s_container       LowCardinality(String),

    attributes          Map(LowCardinality(String), String),
    resource_attributes Map(LowCardinality(String), String),

    INDEX idx_pod k8s_pod TYPE bloom_filter GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (workspace_id, trace_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 30 DAY;
