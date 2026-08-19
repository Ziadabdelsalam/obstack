package receive_test

import (
	"context"
	"encoding/hex"
	"hash/fnv"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metering"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/receive"
)

const (
	testKey     = "ok_dev_test"
	workspaceID = "ws_test"
	// The key the resolver below names, spelled out because the health rows are
	// per key (D100) and the metering assertions are about that attribution.
	keyID = "key_" + workspaceID
)

// testResolver stands in for the keystore: what the receivers have to get right
// is the header and the 401, not where a key is kept.
type testResolver map[string]string

func (r testResolver) Workspace(token string) (auth.Identity, error) {
	ws, ok := r[token]
	if !ok {
		return auth.Identity{}, auth.ErrUnauthorized
	}
	return auth.Identity{WorkspaceID: ws, KeyID: "key_" + ws}, nil
}

// recorder stands in for the batch writer T4 plugs in: it only has to remember
// what it was handed, because per D23 a consumer cannot reject anything.
type recorder struct {
	mu         sync.Mutex
	traces     []ptrace.Traces
	logs       []plog.Logs
	workspaces []string
}

func (r *recorder) ConsumeTraces(_ context.Context, workspaceID string, td ptrace.Traces) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.traces = append(r.traces, td)
	r.workspaces = append(r.workspaces, workspaceID)
}

func (r *recorder) ConsumeLogs(_ context.Context, workspaceID string, ld plog.Logs) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.logs = append(r.logs, ld)
	r.workspaces = append(r.workspaces, workspaceID)
}

func (r *recorder) counts() (traces, logs int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.traces), len(r.logs)
}

func (r *recorder) lastWorkspace() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.workspaces) == 0 {
		return ""
	}
	return r.workspaces[len(r.workspaces)-1]
}

// consumedSpans lists the trace of every span that made it through, hex-encoded
// and in arrival order — the unit the sampling proofs are about is the record,
// not the request.
func (r *recorder) consumedSpans() []string {
	r.mu.Lock()
	defer r.mu.Unlock()

	var ids []string
	for _, td := range r.traces {
		for i := range td.ResourceSpans().Len() {
			rs := td.ResourceSpans().At(i)
			for j := range rs.ScopeSpans().Len() {
				spans := rs.ScopeSpans().At(j).Spans()
				for k := range spans.Len() {
					ids = append(ids, hex.EncodeToString(spanTraceID(spans.At(k))))
				}
			}
		}
	}
	return ids
}

// consumedLogs lists the trace of every log record that made it through. A
// record that carried none reads back as the empty string, which is exactly the
// class that draws for itself.
func (r *recorder) consumedLogs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()

	var ids []string
	for _, ld := range r.logs {
		for i := range ld.ResourceLogs().Len() {
			rl := ld.ResourceLogs().At(i)
			for j := range rl.ScopeLogs().Len() {
				records := rl.ScopeLogs().At(j).LogRecords()
				for k := range records.Len() {
					id := records.At(k).TraceID()
					if id.IsEmpty() {
						ids = append(ids, "")
						continue
					}
					ids = append(ids, hex.EncodeToString(id[:]))
				}
			}
		}
	}
	return ids
}

func spanTraceID(span ptrace.Span) []byte {
	id := span.TraceID()
	return id[:]
}

// fakeMeter stands in for the metering accumulator: what the receive path has
// to get right is which workspace, which key and how many records, not how a
// count becomes a row.
type fakeMeter struct {
	mu       sync.Mutex
	accepted []acceptedCall
	dropped  []droppedCall
}

type acceptedCall struct {
	workspaceID, keyID string
	spans, logs        int64
}

type droppedCall struct {
	workspaceID, keyID string
	reason             metering.DropReason
	records            int64
}

func (m *fakeMeter) RecordAccepted(workspaceID, keyID string, spans, logs int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.accepted = append(m.accepted, acceptedCall{workspaceID, keyID, spans, logs})
}

func (m *fakeMeter) RecordDropped(workspaceID, keyID string, reason metering.DropReason, records int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.dropped = append(m.dropped, droppedCall{workspaceID, keyID, reason, records})
}

func (m *fakeMeter) acceptedCalls() []acceptedCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]acceptedCall(nil), m.accepted...)
}

// droppedRecords sums what was accumulated under one reason, and asserts along
// the way that every call named the workspace and the key the health row is
// addressed by: a count that lands on a blank key never becomes a row at all.
func (m *fakeMeter) droppedRecords(t *testing.T, reason metering.DropReason) int64 {
	t.Helper()

	m.mu.Lock()
	defer m.mu.Unlock()

	var total int64
	for _, call := range m.dropped {
		if call.reason != reason {
			continue
		}
		if call.workspaceID != workspaceID || call.keyID != keyID {
			t.Errorf("drop metered as (%q, %q), want (%q, %q)", call.workspaceID, call.keyID, workspaceID, keyID)
		}
		total += call.records
	}
	return total
}

// panicker is the poison-payload stand-in: a consumer that blows up on every
// record, so the recovery paths on both transports can be exercised.
type panicker struct{}

func (panicker) ConsumeTraces(context.Context, string, ptrace.Traces) {
	panic("consumer exploded on traces")
}

func (panicker) ConsumeLogs(context.Context, string, plog.Logs) {
	panic("consumer exploded on logs")
}

// startServer boots both transports on ephemeral ports.
func startServer(t *testing.T) (*receive.Server, *recorder) {
	t.Helper()

	rec := &recorder{}
	return startServerWith(t, rec), rec
}

func startServerWith(t *testing.T, consumer receive.Consumer) *receive.Server {
	t.Helper()
	return start(t, serverOptions{consumer: consumer})
}

// serverOptions is the receiver under test: a consumer plus the quota state and
// the draw that decide what reaches it.
type serverOptions struct {
	consumer  receive.Consumer
	overQuota bool
	meter     receive.Meter
	rand      func() uint64
}

// startMetered boots a receiver with a meter attached, over or under quota, and
// hands back everything the sampling proofs read.
func startMetered(t *testing.T, overQuota bool, draw func() uint64) (*receive.Server, *recorder, *fakeMeter) {
	t.Helper()

	rec, meter := &recorder{}, &fakeMeter{}
	srv := start(t, serverOptions{consumer: rec, overQuota: overQuota, meter: meter, rand: draw})
	return srv, rec, meter
}

func start(t *testing.T, opts serverOptions) *receive.Server {
	t.Helper()

	srv := receive.New(receive.Config{
		GRPCAddr:  "127.0.0.1:0",
		HTTPAddr:  "127.0.0.1:0",
		Auth:      auth.New(testResolver{testKey: workspaceID}),
		Consumer:  opts.consumer,
		OverQuota: func(string) bool { return opts.overQuota },
		Meter:     opts.meter,
		Rand:      opts.rand,
	})
	if err := srv.Start(); err != nil {
		t.Fatalf("start receivers: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
	})

	select {
	case err := <-srv.Err():
		t.Fatalf("receiver died at boot: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	return srv
}

// traceFixture is one resource span holding two spans of the same trace, so
// tests can tell a span count from a request count.
func traceFixture() ptrace.Traces {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "demo-agent")

	spans := rs.ScopeSpans().AppendEmpty().Spans()
	traceID := pcommon.TraceID{0x4b, 0xf9, 0x2f, 0x35, 0x77, 0xb3, 0x4d, 0xa6, 0xa3, 0xce, 0x92, 0x9d, 0x0e, 0x0e, 0x47, 0x36}
	start := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)

	root := spans.AppendEmpty()
	root.SetTraceID(traceID)
	root.SetSpanID(pcommon.SpanID{0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7})
	root.SetName("POST /chat")
	root.SetKind(ptrace.SpanKindServer)
	root.Attributes().PutStr("http.request.method", "POST")
	root.SetStartTimestamp(pcommon.NewTimestampFromTime(start))
	root.SetEndTimestamp(pcommon.NewTimestampFromTime(start.Add(250 * time.Millisecond)))

	child := spans.AppendEmpty()
	child.SetTraceID(traceID)
	child.SetSpanID(pcommon.SpanID{0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb8})
	child.SetParentSpanID(root.SpanID())
	child.SetName("chat gpt-4o-mini")
	child.Attributes().PutStr("gen_ai.system", "openai")
	child.SetStartTimestamp(pcommon.NewTimestampFromTime(start.Add(10 * time.Millisecond)))
	child.SetEndTimestamp(pcommon.NewTimestampFromTime(start.Add(200 * time.Millisecond)))

	return td
}

// logFixture is one log record carrying trace context, as the demo app's
// LoggingHandler emits.
func logFixture() plog.Logs {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "demo-agent")

	record := rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	record.SetTimestamp(pcommon.NewTimestampFromTime(time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)))
	record.SetSeverityText("INFO")
	record.SetSeverityNumber(plog.SeverityNumberInfo)
	record.Body().SetStr("handled chat request")
	record.SetTraceID(pcommon.TraceID{0x4b, 0xf9, 0x2f, 0x35, 0x77, 0xb3, 0x4d, 0xa6, 0xa3, 0xce, 0x92, 0x9d, 0x0e, 0x0e, 0x47, 0x36})

	return ld
}

// The D165 cross-language pinned vectors. The verdict is FNV-1a 64 over the 16
// raw trace-id bytes, kept iff the hash is a multiple of ten, so a port of it
// has a number to check against and not only a yes/no: these hashes are the
// contract, and T10's drive re-asserts the same hex ids end to end in
// ClickHouse. Amending the verdict function sweeps both suites in one round.
var pinnedVectors = []struct {
	traceID string
	fnv1a   uint64
	keep    bool
}{
	{"00000000000000000000000000000001", 9808873769958073010, true},
	{"00000000000000000000000000000002", 9808872670446444799, false},
	// The W3C trace-context example id, so the pinned set holds a trace that
	// looks like one a real exporter sends rather than only counter values.
	{"4bf92f3577b34da6a3ce929d0e0e4736", 12180425081350451581, false},
}

func traceIDOf(t *testing.T, s string) pcommon.TraceID {
	t.Helper()

	raw, err := hex.DecodeString(s)
	if err != nil || len(raw) != 16 {
		t.Fatalf("trace id %q is not 16 hex-encoded bytes: %v", s, err)
	}
	return pcommon.TraceID(raw)
}

// spansOf builds one span per given trace, all in one scope, so a test can say
// which traces it sent and read back which survived.
func spansOf(t *testing.T, traceIDs ...string) ptrace.Traces {
	t.Helper()

	td := ptrace.NewTraces()
	spans := td.ResourceSpans().AppendEmpty().ScopeSpans().AppendEmpty().Spans()
	for i, id := range traceIDs {
		span := spans.AppendEmpty()
		span.SetTraceID(traceIDOf(t, id))
		span.SetSpanID(pcommon.SpanID{0, 0, 0, 0, 0, 0, 0, byte(i + 1)})
		span.SetName("span")
	}
	return td
}

// logsOf builds one record per given trace; an empty string is the trace-less
// record class, which draws for itself.
func logsOf(t *testing.T, traceIDs ...string) plog.Logs {
	t.Helper()

	ld := plog.NewLogs()
	records := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords()
	for _, id := range traceIDs {
		record := records.AppendEmpty()
		record.Body().SetStr("record")
		if id != "" {
			record.SetTraceID(traceIDOf(t, id))
		}
	}
	return ld
}

func exportSpans(t *testing.T, srv *receive.Server, td ptrace.Traces) {
	t.Helper()

	body := mustMarshal(t, ptraceotlp.NewExportRequestFromTraces(td).MarshalProto)
	resp := post(t, srv, httpRequest{path: "/v1/traces", contentType: contentTypeProto, body: body, bearer: "Bearer " + testKey})
	// Degradation is never a refusal: an over-quota workspace is still answered
	// 200, or its exporter would retry the same records it was meant to shed.
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /v1/traces status = %d, want 200", resp.StatusCode)
	}
}

func exportLogs(t *testing.T, srv *receive.Server, ld plog.Logs) {
	t.Helper()

	body := mustMarshal(t, plogotlp.NewExportRequestFromLogs(ld).MarshalProto)
	resp := post(t, srv, httpRequest{path: "/v1/logs", contentType: contentTypeProto, body: body, bearer: "Bearer " + testKey})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /v1/logs status = %d, want 200", resp.StatusCode)
	}
}

// The pinned verdict itself, asserted as the numbers a second implementation
// would have to reproduce.
func TestQuotaSamplingPinnedVectors(t *testing.T) {
	for _, vector := range pinnedVectors {
		t.Run(vector.traceID, func(t *testing.T) {
			id := traceIDOf(t, vector.traceID)
			sum := fnv.New64a()
			sum.Write(id[:])
			if got := sum.Sum64(); got != vector.fnv1a {
				t.Fatalf("FNV-1a 64 of %s = %d, want the pinned %d", vector.traceID, got, vector.fnv1a)
			}
			if keep := vector.fnv1a%10 == 0; keep != vector.keep {
				t.Fatalf("%s: hash %% 10 == 0 is %v, but the vector claims keep = %v", vector.traceID, keep, vector.keep)
			}
		})
	}

	// And the same vectors through the serving path, which is what makes them a
	// contract rather than a hash test: one export, one span per vector.
	srv, rec, _ := startMetered(t, true, nil)

	var sent []string
	for _, vector := range pinnedVectors {
		sent = append(sent, vector.traceID)
	}
	exportSpans(t, srv, spansOf(t, sent...))

	var want []string
	for _, vector := range pinnedVectors {
		if vector.keep {
			want = append(want, vector.traceID)
		}
	}
	if got := rec.consumedSpans(); !slices.Equal(got, want) {
		t.Fatalf("over quota, spans through = %v, want the pinned survivors %v", got, want)
	}
}

// The exit criterion's shape: a sampled-out trace drops whole and a surviving
// one stays a complete correlated trace — across separate exports and across
// both signals, because that is how a real trace arrives.
func TestQuotaSamplingIsAllOrNothingPerTrace(t *testing.T) {
	const (
		kept    = "00000000000000000000000000000001"
		dropped = "00000000000000000000000000000002"
	)

	srv, rec, meter := startMetered(t, true, nil)

	// Three spans of each trace over two exports, plus a log record on each —
	// the correlated whole the product queries by trace id.
	exportSpans(t, srv, spansOf(t, kept, dropped, kept))
	exportSpans(t, srv, spansOf(t, dropped, kept, dropped))
	exportLogs(t, srv, logsOf(t, kept, dropped))

	spans := rec.consumedSpans()
	if !slices.Equal(spans, []string{kept, kept, kept}) {
		t.Fatalf("spans through = %v, want every span of %s and none of %s", spans, kept, dropped)
	}
	if logs := rec.consumedLogs(); !slices.Equal(logs, []string{kept}) {
		t.Fatalf("log records through = %v, want only the one on the surviving trace", logs)
	}

	// Three spans and one record of the dropped trace, counted per record.
	if got := meter.droppedRecords(t, metering.DropQuota); got != 4 {
		t.Fatalf("dropped_quota metered = %d, want 4", got)
	}
}

// A record with no trace has nothing to be whole with, so it draws for itself
// at the same rate — from the injected source, which is what makes the class
// testable at all.
func TestQuotaSamplingDrawsPerTracelessLogRecord(t *testing.T) {
	var draws atomic.Uint64
	srv, rec, meter := startMetered(t, true, func() uint64 { return draws.Add(1) - 1 })

	// Draws 0..11: one in ten survives, and the verdict is per record rather
	// than per request.
	exportLogs(t, srv, logsOf(t, "", "", "", "", "", "", "", "", "", "", "", ""))

	if got := rec.consumedLogs(); !slices.Equal(got, []string{"", ""}) {
		t.Fatalf("trace-less records through = %d, want the 2 of 12 the draw keeps", len(got))
	}
	if got := meter.droppedRecords(t, metering.DropQuota); got != 10 {
		t.Fatalf("dropped_quota metered = %d, want 10", got)
	}
}

// Under quota nothing is sampled, whatever a trace id hashes to. This is the
// half that has to hold when Postgres is unreachable: the workspace cache reads
// back as not-over-quota (D164d), so an outage of ours must cost a customer
// nothing.
func TestUnderQuotaEverythingIsKept(t *testing.T) {
	srv, rec, meter := startMetered(t, false, nil)

	var sent []string
	for _, vector := range pinnedVectors {
		sent = append(sent, vector.traceID)
	}
	exportSpans(t, srv, spansOf(t, sent...))
	exportLogs(t, srv, logsOf(t, sent[0], ""))

	if got := rec.consumedSpans(); !slices.Equal(got, sent) {
		t.Fatalf("under quota, spans through = %v, want all of %v", got, sent)
	}
	if got := rec.consumedLogs(); !slices.Equal(got, []string{sent[0], ""}) {
		t.Fatalf("under quota, log records through = %v, want both", got)
	}
	if got := meter.droppedRecords(t, metering.DropQuota); got != 0 {
		t.Fatalf("dropped_quota metered = %d under quota, want 0", got)
	}
}

// Quota drops are visible in both places a drop is visible: the Prometheus
// counter operators watch, and the health row the product reads. They are
// counted once, from one call site, so the two cannot drift.
func TestQuotaDropsAreCountedInPrometheusAndTheHealthRow(t *testing.T) {
	srv, _, meter := startMetered(t, true, nil)

	dropped := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonQuota)
	before := testutil.ToFloat64(dropped)

	// Four spans, three of them on the sampled-out trace.
	exportSpans(t, srv, spansOf(t,
		"00000000000000000000000000000002",
		"00000000000000000000000000000002",
		"4bf92f3577b34da6a3ce929d0e0e4736",
		"00000000000000000000000000000001",
	))

	if delta := testutil.ToFloat64(dropped) - before; delta != 3 {
		t.Fatalf("obstack_ingest_dropped_total{reason=quota} delta = %v, want 3", delta)
	}
	if got := meter.droppedRecords(t, metering.DropQuota); got != 3 {
		t.Fatalf("dropped_quota metered = %d, want 3", got)
	}
}

// What survives is metered as the workspace's usage, under the key that carried
// it: the ledger row the billing tab reads and the health row the Data & ingest
// tab reads come from the same call.
func TestAcceptedRecordsAreMeteredPerWorkspaceAndKey(t *testing.T) {
	srv, _, meter := startMetered(t, false, nil)

	exportSpans(t, srv, spansOf(t, pinnedVectors[0].traceID, pinnedVectors[1].traceID))
	exportLogs(t, srv, logsOf(t, pinnedVectors[0].traceID))

	want := []acceptedCall{
		{workspaceID, keyID, 2, 0},
		{workspaceID, keyID, 0, 1},
	}
	if got := meter.acceptedCalls(); !slices.Equal(got, want) {
		t.Fatalf("accepted metered %v, want %v", got, want)
	}
}

// An export that survives nothing is not an export: no consumer call, and no
// accepted series claiming a workspace sent something it did not.
func TestFullySampledExportIsNotHandedOn(t *testing.T) {
	srv, rec, meter := startMetered(t, true, nil)

	accepted := metrics.Accepted.WithLabelValues(workspaceID, metrics.SignalTraces)
	before := testutil.ToFloat64(accepted)

	exportSpans(t, srv, spansOf(t, "00000000000000000000000000000002"))

	if traces, logs := rec.counts(); traces != 0 || logs != 0 {
		t.Fatalf("consumer saw (traces=%d logs=%d) from an export sampled away whole", traces, logs)
	}
	if delta := testutil.ToFloat64(accepted) - before; delta != 0 {
		t.Fatalf("obstack_ingest_accepted_total delta = %v, want 0", delta)
	}
	if len(meter.acceptedCalls()) != 0 {
		t.Fatalf("metered %v accepted from an export sampled away whole", meter.acceptedCalls())
	}
}

// Sampling lives in the shared consume path, so gRPC inherits it without a line
// of its own — the transport a real OTel SDK defaults to.
func TestGRPCInheritsQuotaSampling(t *testing.T) {
	srv, rec, _ := startMetered(t, true, nil)

	ctx, cancel := exportContext(t, "Bearer "+testKey)
	defer cancel()

	td := spansOf(t, "00000000000000000000000000000002", "00000000000000000000000000000001")
	if _, err := ptraceotlp.NewGRPCClient(dial(t, srv)).Export(ctx, ptraceotlp.NewExportRequestFromTraces(td)); err != nil {
		t.Fatalf("gRPC export over quota: %v", err)
	}

	if got := rec.consumedSpans(); !slices.Equal(got, []string{"00000000000000000000000000000001"}) {
		t.Fatalf("gRPC spans through = %v, want only the surviving trace", got)
	}
}
