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
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/mapping"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pricing"
)

// D5 flush bounds.
const (
	DefaultMaxRows       = 10_000
	DefaultFlushInterval = time.Second
)

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
)

// Config describes one writer.
type Config struct {
	// DSN addresses the write user, e.g.
	// clickhouse://obstack_ingest:pw@clickhouse:9000/obstack.
	DSN string

	// MaxRows and FlushInterval default to the D5 bounds.
	MaxRows       int
	FlushInterval time.Duration

	// Prices resolves the price table a workspace's spans are costed with: the
	// embedded list with that workspace's D108 overrides layered on, built once
	// per cache refresh. Nil — and a nil table from a cache that has no answer
	// yet, which is the fail-open state the workspace cache hands back (D164) —
	// means the embedded list.
	Prices func(workspaceID string) *pricing.Table
}

// Writer is the receive.Consumer that lands telemetry in ClickHouse.
type Writer struct {
	conn   driver.Conn
	prices func(workspaceID string) *pricing.Table
	spans  *batcher[mapping.SpanRow]
	logs   *batcher[mapping.LogRow]
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

	w := &Writer{conn: conn, prices: pricesFor(cfg)}
	w.spans = newBatcher("spans", maxRows, interval,
		func(r mapping.SpanRow) string { return r.WorkspaceID }, w.insertSpans)
	w.logs = newBatcher("logs", maxRows, interval,
		func(r mapping.LogRow) string { return r.WorkspaceID }, w.insertLogs)
	return w, nil
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

// Close flushes both tables and closes the connection. Callers stop the
// receivers first; enqueueing after Close is a programming error.
//
// ctx is the shutdown deadline (D263), and BOTH batchers get it before either
// is waited on — that ordering is the whole point (D278). Waiting spans out
// first and only then publishing to logs would leave logs on the ordinary
// unbounded path for however long the spans drain took, free to open one more
// writeTimeout-long attempt just before its own turn came: two writeTimeouts
// end to end, past the 45s grace the chart and compose are sized on. Published
// together, the pair's worst case is the one batcher.close states — the
// deadline for everything queued, plus the single in-flight attempt neither
// batcher can abort, and those two run concurrently. Rows still unwritten when
// ctx ends are counted dropped rather than lost quietly; see batcher.send.
func (w *Writer) Close(ctx context.Context) error {
	w.spans.beginClose(ctx)
	w.logs.beginClose(ctx)
	<-w.spans.stopped
	<-w.logs.stopped
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
