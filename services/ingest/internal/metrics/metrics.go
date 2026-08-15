// Package metrics declares the counters the ingest service exposes on /metrics
// (D6, D9). They live in one place because every stage of the pipeline —
// receive, mapping, write, pricing — reports drops through the same names, and
// because the drop reasons need a fixed vocabulary: `reason` is a metric label,
// so free-form strings would be an unbounded cardinality leak.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Signals carried by the accepted counter.
const (
	SignalTraces = "traces"
	SignalLogs   = "logs"
)

// Drop reasons (D6, D26). Every drop in the pipeline is one of these.
//
// Dropped counts telemetry refused or lost *after* auth, in records where the
// payload was decodable and otherwise one per rejected request (D26).
// ReasonPanic is always one per request, never a record count: a handler that
// died mid-batch cannot say how many of its records it had already enqueued.
// The one ratified exclusion: a gRPC payload that fails to decode is rejected by
// grpc-go's own codec, which runs before the auth interceptor — there is no
// workspace to label with, so those rejections show up in the gRPC error alone
// and never here.
const (
	// ReasonDecode — the OTLP payload could not be unmarshalled. Answered with
	// a single 4xx, never a 5xx that would start an exporter retry loop.
	ReasonDecode = "decode"
	// ReasonUnsupported — the request carried a Content-Type the OTLP/HTTP
	// endpoint does not speak, so its records were refused with a 415.
	ReasonUnsupported = "unsupported"
	// ReasonMapping — a single record could not be turned into a row; the rest
	// of the batch is kept.
	ReasonMapping = "mapping"
	// ReasonOverload — the writer's queue was full, so rows were shed rather
	// than blocking the receiver (D5). Distinct from ReasonWrite: this is our
	// backlog, not ClickHouse refusing the insert.
	ReasonOverload = "overload"
	// ReasonWrite — the batch INSERT failed after its bounded retries (D5).
	ReasonWrite = "write"
	// ReasonPanic — a handler panicked and its records were lost with it. The
	// process survives: both transports recover, count here, and answer with a
	// terminal error rather than dying on a poison payload (D26).
	ReasonPanic = "panic"
)

var (
	// Accepted counts records that passed auth and decode and were handed to
	// the writer.
	Accepted = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "obstack_ingest_accepted_total",
		Help: "Telemetry records accepted for ingestion.",
	}, []string{"workspace_id", "signal"})

	// Dropped counts records that never reached ClickHouse.
	Dropped = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "obstack_ingest_dropped_total",
		Help: "Telemetry records dropped before reaching ClickHouse.",
	}, []string{"workspace_id", "reason"})

	// UnpricedModels counts LLM spans whose model matched no row in the
	// embedded pricing table, and which therefore carry cost_usd = 0 (D9).
	UnpricedModels = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "obstack_ingest_unpriced_models_total",
		Help: "LLM spans whose model matched no row in the embedded pricing table.",
	}, []string{"model"})
)

// Init materialises the per-workspace series at zero for the workspaces this
// process is configured for. Without it a counter is absent from /metrics until
// its first event, which makes rate() over a freshly booted service undefined
// and hides a pipeline that has simply never received anything.
func Init(workspaceIDs []string) {
	signals := []string{SignalTraces, SignalLogs}
	reasons := []string{ReasonDecode, ReasonUnsupported, ReasonMapping, ReasonOverload, ReasonWrite, ReasonPanic}
	for _, ws := range workspaceIDs {
		for _, signal := range signals {
			Accepted.WithLabelValues(ws, signal)
		}
		for _, reason := range reasons {
			Dropped.WithLabelValues(ws, reason)
		}
	}
}
