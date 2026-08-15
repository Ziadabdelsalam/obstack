package receive_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/receive"
)

const (
	testKey     = "ok_dev_test"
	workspaceID = "ws_test"
)

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

	srv := receive.New(receive.Config{
		GRPCAddr: "127.0.0.1:0",
		HTTPAddr: "127.0.0.1:0",
		Auth:     auth.New(map[string]string{testKey: workspaceID}),
		Consumer: consumer,
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
