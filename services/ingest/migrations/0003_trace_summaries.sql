-- Trace summaries (D7): the one table every search / list / overview surface
-- reads. Rows arrive as partial aggregates from the materialized view below,
-- one per inserted block, so a trace whose spans land in several batches has
-- several rows here.
--
-- QUERY RULE (binding, D7): always read this table with
--   GROUP BY workspace_id, trace_id
-- plus the matching combinator (plain min/max/sum for SimpleAggregateFunction
-- columns, -Merge for AggregateFunction ones). Never FINAL, never a bare
-- SELECT — unmerged parts would under-report.
--
-- DUPLICATE RISK (accepted for Phase 1, D23): spans is a plain MergeTree, so an
-- OTLP client that retries a batch ingest already ACKed re-inserts those spans
-- and double-counts them in the sums here — as does ingest's own bounded write
-- retry, whose second attempt may land after an INSERT that only appeared to
-- fail.
CREATE TABLE IF NOT EXISTS obstack.trace_summaries
(
    workspace_id        LowCardinality(String),
    trace_id            String,
    min_start           SimpleAggregateFunction(min, DateTime64(9, 'UTC')),
    max_end             SimpleAggregateFunction(max, DateTime64(9, 'UTC')),
    span_count          SimpleAggregateFunction(sum, UInt64),
    error_count         SimpleAggregateFunction(sum, UInt64),
    total_input_tokens  SimpleAggregateFunction(sum, UInt64),
    total_output_tokens SimpleAggregateFunction(sum, UInt64),
    total_cost_usd      SimpleAggregateFunction(sum, Float64),
    services            SimpleAggregateFunction(groupUniqArrayArray, Array(String)),
    models              SimpleAggregateFunction(groupUniqArrayArray, Array(String)),

    -- Root fields are argMinIf states rather than plain values: the root span
    -- may arrive in a later batch than its children, and an empty state merges
    -- cleanly with the one that eventually carries it.
    root_name           AggregateFunction(argMinIf, String, DateTime64(9, 'UTC'), UInt8),
    root_method         AggregateFunction(argMinIf, String, DateTime64(9, 'UTC'), UInt8),
    root_service        AggregateFunction(argMinIf, String, DateTime64(9, 'UTC'), UInt8),

    max_seen_date       SimpleAggregateFunction(max, Date)
)
ENGINE = AggregatingMergeTree
ORDER BY (workspace_id, trace_id)
TTL max_seen_date + INTERVAL 30 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS obstack.trace_summaries_mv TO obstack.trace_summaries AS
SELECT
    workspace_id,
    trace_id,
    min(start_time) AS min_start,
    max(addNanoseconds(start_time, duration_ns)) AS max_end,
    count() AS span_count,
    countIf(status_code = 'error') AS error_count,
    sum(input_tokens) AS total_input_tokens,
    sum(output_tokens) AS total_output_tokens,
    sum(cost_usd) AS total_cost_usd,
    groupUniqArrayIf(toString(service), service != '') AS services,
    groupUniqArrayArray(arrayFilter(m -> m != '', [toString(gen_ai_request_model), toString(gen_ai_response_model)])) AS models,
    argMinIfState(name, start_time, parent_span_id = '') AS root_name,
    argMinIfState(attributes['http.request.method'], start_time, parent_span_id = '') AS root_method,
    argMinIfState(toString(service), start_time, parent_span_id = '') AS root_service,
    max(toDate(start_time)) AS max_seen_date
FROM obstack.spans
GROUP BY workspace_id, trace_id;
