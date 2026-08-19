package write

import (
	"context"
	"errors"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/mapping"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pricing"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/receive"
)

// The writer is what the receivers hand telemetry to; the interface is the D23
// contract that consuming cannot fail.
var _ receive.Consumer = (*Writer)(nil)

// recorder captures the batches an insert func is asked to write.
type recorder struct {
	mu      sync.Mutex
	batches [][]mapping.SpanRow
	err     error
}

func (r *recorder) insert(_ context.Context, rows []mapping.SpanRow) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.batches = append(r.batches, append([]mapping.SpanRow(nil), rows...))
	return r.err
}

func (r *recorder) sizes() []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	sizes := make([]int, len(r.batches))
	for i, b := range r.batches {
		sizes[i] = len(b)
	}
	return sizes
}

func (r *recorder) rows() []mapping.SpanRow {
	r.mu.Lock()
	defer r.mu.Unlock()
	var rows []mapping.SpanRow
	for _, b := range r.batches {
		rows = append(rows, b...)
	}
	return rows
}

func spanRows(n int) []mapping.SpanRow {
	rows := make([]mapping.SpanRow, n)
	for i := range rows {
		rows[i] = mapping.SpanRow{WorkspaceID: "ws_test", Layer: mapping.LayerOther}
	}
	return rows
}

func TestBatcherFlushesAtMaxRows(t *testing.T) {
	rec := &recorder{}
	// An interval long enough that only the row bound can fire.
	b := newBatcher("spans", 3, time.Hour, func(r mapping.SpanRow) string { return r.WorkspaceID }, rec.insert)

	b.enqueue(spanRows(7))
	b.close()

	got := rec.sizes()
	want := []int{3, 3, 1} // two full batches, then the shutdown flush
	if len(got) != len(want) {
		t.Fatalf("batch sizes = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("batch sizes = %v, want %v", got, want)
		}
	}
}

func TestBatcherFlushesOnInterval(t *testing.T) {
	rec := &recorder{}
	b := newBatcher("spans", 1000, 50*time.Millisecond, func(r mapping.SpanRow) string { return r.WorkspaceID }, rec.insert)
	t.Cleanup(b.close)

	b.enqueue(spanRows(2))

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if sizes := rec.sizes(); len(sizes) == 1 && sizes[0] == 2 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no interval flush within 5s; batches = %v", rec.sizes())
}

// D5 + D23: a batch that will not write is retried a bounded number of times and
// then dropped and counted — never turned into an error the exporter would see,
// because the exporter was told "accepted" the moment the rows were enqueued.
func TestFailedInsertRetriesThenDropsAndCounts(t *testing.T) {
	counter := metrics.Dropped.WithLabelValues("ws_test", metrics.ReasonWrite)
	before := testutil.ToFloat64(counter)

	rec := &recorder{err: errors.New("clickhouse is down")}
	b := newBatcher("spans", 1000, time.Hour, func(r mapping.SpanRow) string { return r.WorkspaceID }, rec.insert)

	b.enqueue(spanRows(2))
	b.close()

	if attempts := len(rec.sizes()); attempts != maxAttempts {
		t.Errorf("insert attempts = %d, want %d", attempts, maxAttempts)
	}
	if delta := testutil.ToFloat64(counter) - before; delta != 2 {
		t.Errorf("write drop delta = %v, want 2", delta)
	}
}

// D167: the price table is a per-workspace cache read the writer makes once per
// export, and it is the table the enqueued rows are costed with.
func TestConsumeTracesPricesWithTheWorkspaceTable(t *testing.T) {
	rec := &recorder{}
	var asked []string
	w := &Writer{prices: pricesFor(Config{Prices: func(workspaceID string) *pricing.Table {
		asked = append(asked, workspaceID)
		if workspaceID != "ws_deal" {
			return nil
		}
		return pricing.Default.WithOverrides([]pricing.Rate{
			{Match: "acme-llm-9", InputPerMTok: 4, OutputPerMTok: 12},
		})
	}})}
	w.spans = newBatcher("spans", 1000, time.Hour,
		func(r mapping.SpanRow) string { return r.WorkspaceID }, rec.insert)

	w.ConsumeTraces(context.Background(), "ws_deal", llmTrace("acme-llm-9-turbo"))
	w.ConsumeTraces(context.Background(), "ws_base", llmTrace("acme-llm-9-turbo"))
	w.spans.close()

	if len(asked) != 2 || asked[0] != "ws_deal" || asked[1] != "ws_base" {
		t.Fatalf("price lookups = %v, want one per export, per workspace", asked)
	}
	costs := map[string]float64{}
	for _, row := range rec.rows() {
		costs[row.WorkspaceID] = row.CostUSD
	}
	if want := 1000 * 4.0 / 1e6; math.Abs(costs["ws_deal"]-want) > 1e-12 {
		t.Errorf("ws_deal cost_usd = %v, want %v", costs["ws_deal"], want)
	}
	// The other workspace has no override and no base row for this model: the
	// fail-open nil table is the embedded list, not no table at all.
	if costs["ws_base"] != 0 {
		t.Errorf("ws_base cost_usd = %v, want 0", costs["ws_base"])
	}
}

// A writer with no resolver at all — the shape every test writer and the D5
// batcher tests use — still prices off the embedded list.
func TestPricesDefaultToTheEmbeddedTable(t *testing.T) {
	if got := pricesFor(Config{})("ws_test"); got != pricing.Default {
		t.Errorf("pricesFor(Config{}) = %p, want pricing.Default", got)
	}
}

// llmTrace is one minimally valid LLM span, the only shape carrying a cost.
func llmTrace(model string) ptrace.Traces {
	td := ptrace.NewTraces()
	span := td.ResourceSpans().AppendEmpty().ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	span.SetTraceID(pcommon.TraceID{0x4b, 0xf9, 0x2f, 0x35, 0x77, 0xb3, 0x4d, 0xa6, 0xa3, 0xce, 0x92, 0x9d, 0x0e, 0x0e, 0x47, 0x36})
	span.SetSpanID(pcommon.SpanID{0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7})
	span.SetName("chat")
	span.SetStartTimestamp(pcommon.NewTimestampFromTime(time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)))
	span.Attributes().PutStr("gen_ai.request.model", model)
	span.Attributes().PutInt("gen_ai.usage.input_tokens", 1000)
	return td
}

// A queue that has run out of room sheds rows rather than blocking the OTLP
// handler that is holding a client's connection open. The shed counts as
// "overload", not "write": nothing was refused by ClickHouse (D26).
func TestFullQueueShedsAndCounts(t *testing.T) {
	counter := metrics.Dropped.WithLabelValues("ws_full", metrics.ReasonOverload)
	writeCounter := metrics.Dropped.WithLabelValues("ws_full", metrics.ReasonWrite)
	before := testutil.ToFloat64(counter)
	beforeWrite := testutil.ToFloat64(writeCounter)

	blocked := make(chan struct{})
	b := newBatcher("spans", 1, time.Hour,
		func(r mapping.SpanRow) string { return r.WorkspaceID },
		func(context.Context, []mapping.SpanRow) error {
			<-blocked
			return nil
		})

	// One row occupies the flusher, queueBatches more fill the channel, and
	// everything past that is shed.
	rows := spanRows(2 + queueBatches)
	for i := range rows {
		rows[i].WorkspaceID = "ws_full"
	}
	b.enqueue(rows)

	if delta := testutil.ToFloat64(counter) - before; delta < 1 {
		t.Errorf("overload drop delta = %v, want at least 1", delta)
	}
	if delta := testutil.ToFloat64(writeCounter) - beforeWrite; delta != 0 {
		t.Errorf("write drop delta = %v, want 0 — a shed is not a failed INSERT", delta)
	}
	close(blocked)
	b.close()
}
