// Package write persists mapped rows to ClickHouse through the D5 micro-batcher:
// per-table buffered channels, a native batch INSERT every 10k rows or every
// second, whichever comes first, and a bounded retry before the batch is dropped
// and counted. There is deliberately no queue and no async_insert — one process
// owning its own buffer is the smallest thing that turns thousands of small OTLP
// exports into the large blocks ClickHouse wants.
//
// The writer acknowledges on enqueue (D23): ConsumeTraces and ConsumeLogs cannot
// fail, because the OTLP response has already been earned by passing auth and
// decode. A write that never lands is a counted drop, not an exporter error — an
// error would only make the client re-send data that is very likely already in
// the table.
package write

import (
	"context"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/mapping"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pricing"
)

// D5 flush bounds.
const (
	DefaultMaxRows       = 10_000
	DefaultFlushInterval = time.Second
)

// DefaultSeriesCap is the D363 §2 cardinality cap admitted through
// mapping.NewSeriesCache: 25,000 active series per workspace, sized to cover a
// mid-size k8s cluster's metrics volume with headroom while still catching a
// label-explosion bug within minutes.
const DefaultSeriesCap = 25_000

// Column lists are spelled out rather than left to INSERT's positional default:
// the writer must keep setting `layer` on every row (D22), and a schema change
// that silently shifted a column would otherwise mis-type data instead of
// failing.
const (
	insertSpans = `INSERT INTO obstack.spans (
		workspace_id, trace_id, span_id, parent_span_id, name, kind, service,
		start_time, duration_ns, status_code, status_message, layer,
		gen_ai_system, gen_ai_request_model, gen_ai_response_model,
		input_tokens, output_tokens, cost_usd, finish_reason, prompt, completion,
		k8s_namespace, k8s_pod, k8s_container, k8s_node,
		attributes, resource_attributes)`

	insertLogs = `INSERT INTO obstack.logs (
		workspace_id, timestamp, trace_id, span_id, severity_number, severity_text,
		body, service, prompt, completion, k8s_namespace, k8s_pod, k8s_container,
		attributes, resource_attributes)`

	insertMetrics = `INSERT INTO obstack.metric_points (
		workspace_id, name, type, unit, service, series_hash, timestamp, value,
		is_monotonic, bounds, bucket_counts, h_sum, h_count, h_min, h_max,
		attributes, resource_attributes)`
)

// selectActiveSeries is D376's boot reconciliation source: the hashes
// obstack.metric_series already considers active, "last_seen within the
// current UTC day" (packet §2), read per D380 exactly as the stored column
// keeps it — point time, not ingest wall-clock.
//
// metric_series is an AggregatingMergeTree, so this obeys the house query rule
// the 0005 DDL states verbatim — group by the series key, apply the column's
// own aggregate (last_seen is SimpleAggregateFunction(max, ...)), never a bare
// SELECT. It also collapses the duplicate rows unmerged parts would otherwise
// hand back for one series. The day boundary is pinned to UTC the way
// retention.go pins its own (`now('UTC')`): today() would follow the server's
// timezone, and the packet's window is a UTC day.
const selectActiveSeries = `
	SELECT workspace_id, series_hash
	FROM obstack.metric_series
	GROUP BY workspace_id, series_hash
	HAVING max(last_seen) >= toStartOfDay(now('UTC'))`

// Config describes one writer.
type Config struct {
	// DSN addresses the write user, e.g.
	// clickhouse://obstack_ingest:pw@clickhouse:9000/obstack.
	DSN string

	// MaxRows and FlushInterval default to the D5 bounds.
	MaxRows       int
	FlushInterval time.Duration

	// SeriesCap bounds the per-workspace active-series count
	// mapping.NewSeriesCache admits (D376). Defaults to DefaultSeriesCap; tests
	// lower it to prove the cap without generating 25,000 series.
	//
	// TEST SEAM ONLY (D385): the cap is a product constant, cross-pinned to
	// the web's SERIES_CAP by a parity test — never wire this to an env var,
	// a flag, or chart values. Making it deployment-configurable is a
	// pre-registered advisor escalation whose precondition is a web-visible
	// source of the effective value (D13): a cap the product cannot state is
	// not one an operator should be able to move.
	SeriesCap int

	// Prices resolves the price table a workspace's spans are costed with: the
	// embedded list with that workspace's D108 overrides layered on, built once
	// per cache refresh. Nil — and a nil table from a cache that has no answer
	// yet, which is the fail-open state the workspace cache hands back (D164) —
	// means the embedded list.
	Prices func(workspaceID string) *pricing.Table
}

// Writer is the receive.Consumer that lands telemetry in ClickHouse.
type Writer struct {
	conn        driver.Conn
	prices      func(workspaceID string) *pricing.Table
	spans       *batcher[mapping.SpanRow]
	logs        *batcher[mapping.LogRow]
	metrics     *batcher[mapping.MetricRow]
	seriesCache *mapping.SeriesCache
}

// New connects and starts the per-table batchers. It pings: a DSN that cannot
// reach ClickHouse is a boot failure, not something to discover an hour later
// when the first export is silently dropped.
func New(ctx context.Context, cfg Config) (*Writer, error) {
	opts, err := clickhouse.ParseDSN(cfg.DSN)
	if err != nil {
		return nil, fmt.Errorf("parse CLICKHOUSE_DSN: %w", err)
	}
	conn, err := clickhouse.Open(opts)
	if err != nil {
		return nil, fmt.Errorf("open clickhouse: %w", err)
	}
	if err := conn.Ping(ctx); err != nil {
		conn.Close()
		return nil, fmt.Errorf("ping clickhouse: %w", err)
	}

	maxRows := cfg.MaxRows
	if maxRows <= 0 {
		maxRows = DefaultMaxRows
	}
	interval := cfg.FlushInterval
	if interval <= 0 {
		interval = DefaultFlushInterval
	}
	seriesCap := cfg.SeriesCap
	if seriesCap <= 0 {
		seriesCap = DefaultSeriesCap
	}

	// Boot reconciliation (D376): a process that just started must not re-reject
	// a series merely because it has not personally seen it yet, so the cache
	// starts seeded from what obstack.metric_series already considers active.
	seriesCache := mapping.NewSeriesCache(seriesCap)
	if err := seedSeriesCache(ctx, conn, seriesCache); err != nil {
		conn.Close()
		return nil, fmt.Errorf("seed series cache: %w", err)
	}

	w := &Writer{conn: conn, prices: pricesFor(cfg), seriesCache: seriesCache}
	w.spans = newBatcher("spans", maxRows, interval,
		func(r mapping.SpanRow) string { return r.WorkspaceID }, w.insertSpans)
	w.logs = newBatcher("logs", maxRows, interval,
		func(r mapping.LogRow) string { return r.WorkspaceID }, w.insertLogs)
	w.metrics = newBatcher("metric_points", maxRows, interval,
		func(r mapping.MetricRow) string { return r.WorkspaceID }, w.insertMetrics)
	return w, nil
}

// seedSeriesCache runs selectActiveSeries and loads each workspace's active
// hashes into cache (D376). It errors like the ping above: a writer whose cap
// cannot be trusted at boot should fail to boot, not silently admit past what
// the cap was ever supposed to allow.
func seedSeriesCache(ctx context.Context, conn driver.Conn, cache *mapping.SeriesCache) error {
	rows, err := conn.Query(ctx, selectActiveSeries)
	if err != nil {
		return fmt.Errorf("query active series: %w", err)
	}
	defer rows.Close()

	byWorkspace := map[string][]uint64{}
	for rows.Next() {
		var workspaceID string
		var hash uint64
		if err := rows.Scan(&workspaceID, &hash); err != nil {
			return fmt.Errorf("scan active series: %w", err)
		}
		byWorkspace[workspaceID] = append(byWorkspace[workspaceID], hash)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("active series rows: %w", err)
	}
	for workspaceID, hashes := range byWorkspace {
		cache.Seed(workspaceID, hashes)
	}
	return nil
}

// pricesFor turns Config.Prices into the resolver the writer calls, with the
// one place the "no answer means the embedded list" rule lives. Both nils are
// the same fail-open answer (D164): our own cache outage must show a workspace
// list prices, never no prices at all.
func pricesFor(cfg Config) func(workspaceID string) *pricing.Table {
	return func(workspaceID string) *pricing.Table {
		if cfg.Prices != nil {
			if table := cfg.Prices(workspaceID); table != nil {
				return table
			}
		}
		return pricing.Default
	}
}

// ConsumeTraces maps and enqueues a decoded trace export. The request context is
// not carried into the write: the response is already on its way out, and a
// batch must not be cancelled by the client that happened to fill it.
//
// The price table is resolved here, once per export: it is a cache read, and the
// workspace's overrides must be the ones in force when the export arrived rather
// than whatever the refresh loop holds by the time the batch flushes.
func (w *Writer) ConsumeTraces(_ context.Context, workspaceID string, td ptrace.Traces) {
	w.spans.enqueue(mapping.SpanRows(workspaceID, td, w.prices(workspaceID)))
}

// ConsumeLogs maps and enqueues a decoded log export.
func (w *Writer) ConsumeLogs(_ context.Context, workspaceID string, ld plog.Logs) {
	w.logs.enqueue(mapping.LogRows(workspaceID, ld))
}

// ConsumeMetrics maps and enqueues a decoded metrics export through the shared
// SeriesCache (D376): admission against the 25k-series cap happens inside
// MetricRows itself, never here — this method plumbs the cache in and hands
// the cardinality-drop count back across the receive.Consumer boundary, which
// is what lets receive.go's countDrop fire both drop surfaces (the Prometheus
// counter and the api_key_health.dropped_cardinality column) from one call
// site, using the API key identity only receive.go has.
func (w *Writer) ConsumeMetrics(_ context.Context, workspaceID string, md pmetric.Metrics) (cardinalityDrops int) {
	rows, drops := mapping.MetricRows(workspaceID, md, w.seriesCache)
	w.metrics.enqueue(rows)
	return drops
}

// Close flushes all three tables and closes the connection. Callers stop the
// receivers first; enqueueing after Close is a programming error.
//
// ctx is the shutdown deadline (D263), and every batcher gets it before any of
// them is waited on — that ordering is the whole point (D278). Waiting spans
// out first and only then publishing to logs (and metrics) would leave the
// later ones on the ordinary unbounded path for however long the earlier
// drain took, free to open one more writeTimeout-long attempt just before
// their own turn came: worst case stacks one writeTimeout per batcher, past
// the 45s grace the chart and compose are sized on. Published together, the
// group's worst case is the one batcher.close states — the deadline for
// everything queued, plus the single in-flight attempt no batcher can abort,
// and all of them run concurrently. Rows still unwritten when ctx ends are
// counted dropped rather than lost quietly; see batcher.send.
func (w *Writer) Close(ctx context.Context) error {
	w.spans.beginClose(ctx)
	w.logs.beginClose(ctx)
	w.metrics.beginClose(ctx)
	<-w.spans.stopped
	<-w.logs.stopped
	<-w.metrics.stopped
	return w.conn.Close()
}

func (w *Writer) insertSpans(ctx context.Context, rows []mapping.SpanRow) error {
	batch, err := w.conn.PrepareBatch(ctx, insertSpans)
	if err != nil {
		return fmt.Errorf("prepare spans batch: %w", err)
	}
	for _, r := range rows {
		if err := batch.Append(
			r.WorkspaceID, r.TraceID, r.SpanID, r.ParentSpanID, r.Name, r.Kind, r.Service,
			r.StartTime, r.DurationNS, r.StatusCode, r.StatusMessage, r.Layer,
			r.GenAISystem, r.GenAIRequestModel, r.GenAIResponseModel,
			r.InputTokens, r.OutputTokens, r.CostUSD, r.FinishReason, r.Prompt, r.Completion,
			r.K8sNamespace, r.K8sPod, r.K8sContainer, r.K8sNode,
			r.Attributes, r.ResourceAttributes,
		); err != nil {
			batch.Abort()
			return fmt.Errorf("append span %s/%s: %w", r.TraceID, r.SpanID, err)
		}
	}
	return batch.Send()
}

func (w *Writer) insertLogs(ctx context.Context, rows []mapping.LogRow) error {
	batch, err := w.conn.PrepareBatch(ctx, insertLogs)
	if err != nil {
		return fmt.Errorf("prepare logs batch: %w", err)
	}
	for _, r := range rows {
		if err := batch.Append(
			r.WorkspaceID, r.Timestamp, r.TraceID, r.SpanID, r.SeverityNumber, r.SeverityText,
			r.Body, r.Service, r.Prompt, r.Completion, r.K8sNamespace, r.K8sPod, r.K8sContainer,
			r.Attributes, r.ResourceAttributes,
		); err != nil {
			batch.Abort()
			return fmt.Errorf("append log %s: %w", r.Timestamp, err)
		}
	}
	return batch.Send()
}

func (w *Writer) insertMetrics(ctx context.Context, rows []mapping.MetricRow) error {
	batch, err := w.conn.PrepareBatch(ctx, insertMetrics)
	if err != nil {
		return fmt.Errorf("prepare metric_points batch: %w", err)
	}
	for _, r := range rows {
		if err := batch.Append(
			r.WorkspaceID, r.Name, r.Type, r.Unit, r.Service, r.SeriesHash, r.Timestamp, r.Value,
			r.IsMonotonic, r.Bounds, r.BucketCounts, r.HSum, r.HCount, r.HMin, r.HMax,
			r.Attributes, r.ResourceAttributes,
		); err != nil {
			batch.Abort()
			return fmt.Errorf("append metric point %s/%d: %w", r.Name, r.SeriesHash, err)
		}
	}
	return batch.Send()
}
