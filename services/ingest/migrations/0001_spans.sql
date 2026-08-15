-- Spans (D7). Trace fetch is the hot path, so the ordering key leads with
-- (workspace_id, trace_id); time-range listing is served by trace_summaries and
-- never touches this table.
CREATE TABLE IF NOT EXISTS obstack.spans
(
    workspace_id          LowCardinality(String),
    trace_id              String,
    span_id               String,
    parent_span_id        String,
    name                  String,
    kind                  Enum8('unspecified' = 0, 'internal' = 1, 'server' = 2, 'client' = 3, 'producer' = 4, 'consumer' = 5),
    service               LowCardinality(String),
    start_time            DateTime64(9, 'UTC'),
    duration_ns           UInt64,
    status_code           Enum8('unset' = 0, 'ok' = 1, 'error' = 2),
    status_message        String,

    -- Computed at ingest by internal/mapping (D8); never derived at query time.
    -- 'other' is 0 (D22) so an omitted column defaults to the catch-all rather
    -- than silently claiming a real layer.
    layer                 Enum8('other' = 0, 'api' = 1, 'agent' = 2, 'tool' = 3, 'llm' = 4, 'infra' = 5),

    -- GenAI columns are first-class rather than map lookups: every LLM view in
    -- the product filters and aggregates on them.
    gen_ai_system         LowCardinality(String),
    gen_ai_request_model  LowCardinality(String),
    gen_ai_response_model LowCardinality(String),
    input_tokens          UInt32,
    output_tokens         UInt32,
    cost_usd              Float64,
    finish_reason         LowCardinality(String),
    prompt                String CODEC(ZSTD(3)),
    completion            String CODEC(ZSTD(3)),

    k8s_namespace         LowCardinality(String),
    k8s_pod               LowCardinality(String),
    k8s_container         LowCardinality(String),
    k8s_node              LowCardinality(String),

    attributes            Map(LowCardinality(String), String),
    resource_attributes   Map(LowCardinality(String), String)
)
ENGINE = MergeTree
PARTITION BY toDate(start_time)
ORDER BY (workspace_id, trace_id, span_id)
TTL toDateTime(start_time) + INTERVAL 30 DAY;
