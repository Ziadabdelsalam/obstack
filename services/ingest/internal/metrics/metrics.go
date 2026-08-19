// Package metrics declares the counters the ingest service exposes on /metrics
// (D6, D9). They live in one place because every stage of the pipeline —
// receive, mapping, write, pricing — reports drops through the same names, and
// because the drop reasons need a fixed vocabulary: `reason` is a metric label,
// so free-form strings would be an unbounded cardinality leak. The one label
// that cannot have a fixed vocabulary — the unpriced model name, which is
// whatever the caller sent — is bounded by a cap instead (D29).
package metrics

import (
	"fmt"
	"sync"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	dto "github.com/prometheus/client_model/go"
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
	// ReasonQuota — the workspace is over its plan's quota, so head sampling
	// shed these records (D165). A drop here is degradation, not a refusal: the
	// export was still answered 200 and the surviving tenth went through whole
	// traces at a time. Counted per record, because a sampled-out trace is a
	// known number of spans and log records rather than an unreadable payload.
	ReasonQuota = "quota"
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

// The per-workspace series of the two counters below appear on a workspace's
// first event, not at boot: the set of workspaces lives in Postgres and is
// resolved key by key as traffic arrives (D98/D151), so there is nothing for the
// process to materialise at zero on the way up — a workspace's absence from
// /metrics means it has sent nothing, and rate() over it is undefined until it
// does.
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

	// unpricedModels counts LLM spans whose model matched no row in the
	// embedded pricing table, and which therefore carry cost_usd = 0 (D9). It
	// stays unexported so the D29 cap has exactly one door: `model` is a string
	// the caller's SDK chose, so a second increment site would be the unbounded
	// cardinality leak the cap exists to close. Increment through
	// CountUnpricedModel, read through UnpricedModelCounts.
	unpricedModels = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "obstack_ingest_unpriced_models_total",
		Help: fmt.Sprintf("LLM spans whose model matched no row in the embedded pricing table "+
			"(at most %d distinct models per process, the rest under model=%q).",
			MaxUnpricedModelLabels, UnpricedModelOverflow),
	}, []string{"model"})
)

// The D29 cap on obstack_ingest_unpriced_models_total{model}. The metric exists
// to surface the models the price table is missing, so an allowlist would defeat
// it: the bound is on how many distinct names one process will ever admit, not
// on which ones. First come, first served — the first MaxUnpricedModelLabels
// names keep their own series and every later name lands in one fixed bucket, so
// "the table has a hole" stays visible while the series count stays flat under a
// tenant sending model names we have never heard of.
const (
	// MaxUnpricedModelLabels is that cap, counted per process lifetime.
	MaxUnpricedModelLabels = 100

	// UnpricedModelOverflow is that fixed bucket. A caller who sends this exact
	// literal as a model name is simply counted in it — bounded either way.
	UnpricedModelOverflow = "_overflow"
)

var unpricedModelLabels = struct {
	mu    sync.Mutex
	names map[string]struct{}
}{names: make(map[string]struct{}, MaxUnpricedModelLabels)}

// CountUnpricedModel counts one span whose model matched no pricing row, under
// its own label while the cap allows and under UnpricedModelOverflow after.
func CountUnpricedModel(model string) {
	unpricedModelLabels.mu.Lock()
	if _, admitted := unpricedModelLabels.names[model]; !admitted {
		if len(unpricedModelLabels.names) >= MaxUnpricedModelLabels {
			model = UnpricedModelOverflow
		} else {
			unpricedModelLabels.names[model] = struct{}{}
		}
	}
	unpricedModelLabels.mu.Unlock()
	unpricedModels.WithLabelValues(model).Inc()
}

// UnpricedModelCounts snapshots the counter by model label. It collects rather
// than looking labels up, because a vector lookup creates the series it reads:
// the number of keys returned here is exactly the cardinality the cap bounds, so
// reading must not be able to add to it.
func UnpricedModelCounts() map[string]float64 {
	ch := make(chan prometheus.Metric)
	go func() {
		unpricedModels.Collect(ch)
		close(ch)
	}()
	counts := map[string]float64{}
	for metric := range ch {
		var m dto.Metric
		if err := metric.Write(&m); err != nil {
			continue
		}
		for _, label := range m.GetLabel() {
			if label.GetName() == "model" {
				counts[label.GetValue()] = m.GetCounter().GetValue()
			}
		}
	}
	return counts
}
