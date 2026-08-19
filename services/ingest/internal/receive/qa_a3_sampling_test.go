package receive

import (
	"context"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
)

type qaA3Consumer struct{ spans, logs int }

func (c *qaA3Consumer) ConsumeTraces(_ context.Context, _ string, td ptrace.Traces) {
	c.spans += td.SpanCount()
}

func (c *qaA3Consumer) ConsumeLogs(_ context.Context, _ string, ld plog.Logs) {
	c.logs += ld.LogRecordCount()
}

const qaA3Workspace = "ws_qa_a3_tracelesss"

func qaA3Context() context.Context {
	return auth.ContextWithIdentity(context.Background(),
		auth.Identity{WorkspaceID: qaA3Workspace, KeyID: "key_qa_a3"})
}

// qaA3TracelessSpans builds n spans that carry no trace id at all — the raw
// 16 zero bytes, which is what an exporter that never set one puts on the wire
// and what the JSON encoding `"traceId": ""` decodes to.
func qaA3TracelessSpans(n int) ptrace.Traces {
	td := ptrace.NewTraces()
	ss := td.ResourceSpans().AppendEmpty().ScopeSpans().AppendEmpty()
	now := pcommon.NewTimestampFromTime(time.Unix(1755600000, 0))
	for range n {
		span := ss.Spans().AppendEmpty()
		span.SetTraceID(pcommon.NewTraceIDEmpty())
		span.SetName("qa-a3-traceless")
		span.SetStartTimestamp(now)
		span.SetEndTimestamp(now)
	}
	return td
}

func qaA3TracelessLogs(n int) plog.Logs {
	ld := plog.NewLogs()
	sl := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty()
	now := pcommon.NewTimestampFromTime(time.Unix(1755600000, 0))
	for range n {
		record := sl.LogRecords().AppendEmpty()
		record.SetTraceID(pcommon.NewTraceIDEmpty())
		record.SetTimestamp(now)
		record.Body().SetStr("qa-a3-traceless")
	}
	return ld
}

// B3-2 — over quota, a record with no trace id is shed at 100% if it is a span
// and at the ruled rate if it is a log record. One record class, two verdicts.
//
// sampleLogs/keepRecord spell the class out: "a record with no trace id has
// nothing to be whole with, so it draws for itself at the same rate (D165)".
// sampleTraces has no such branch — it hands the all-zero trace id straight to
// keepTrace, whose FNV-1a 64 over sixteen zero bytes is 0x88201fb960ff6465,
// h%10 == 1, a deterministic DROP. Not a tenth of the trace-less spans survive:
// none of them do, in every export, on every replica, forever.
//
// The injected Rand here is the ruled per-record draw pinned to KEEP, so the
// assertion is not about a rate at all — it is that the trace-less class is
// sampled rather than annihilated, and that the two signals agree about it.
//
// Reproduced against the running stack first: over quota, 100 spans with an
// all-zero trace id were answered 200 and 0 reached ClickHouse, while 100
// trace-less log records in the same state put 11 through.
func TestQAA3TracelessSpansDrawLikeTracelessLogRecords(t *testing.T) {
	consumer := &qaA3Consumer{}
	srv := New(Config{
		Consumer:  consumer,
		OverQuota: func(string) bool { return true },
		// The D165 per-record draw, pinned to the KEEP verdict.
		Rand: func() uint64 { return 0 },
	})

	const n = 20
	ctx := qaA3Context()

	// The control: trace-less LOG records already honor the injected draw.
	srv.consumeLogs(ctx, qaA3Workspace, plogotlp.NewExportRequestFromLogs(qaA3TracelessLogs(n)))
	if consumer.logs != n {
		t.Fatalf("trace-less log records through = %d, want %d — the injected draw is not "+
			"reaching keepRecord, so the rest of this test proves nothing", consumer.logs, n)
	}

	// The bug: trace-less SPANS never draw. keepTrace's verdict on sixteen zero
	// bytes is a fixed drop, so the whole class is shed at 100%.
	srv.consumeTraces(ctx, qaA3Workspace, ptraceotlp.NewExportRequestFromTraces(qaA3TracelessSpans(n)))
	if consumer.spans != n {
		t.Fatalf("trace-less spans through = %d, want %d — over quota a span with no trace id "+
			"is hashed as sixteen zero bytes (FNV-1a 64 = 0x88201fb960ff6465, h%%10 = 1) and so "+
			"is dropped deterministically, every time, while a trace-less log record of the same "+
			"class draws per record at the ruled rate", consumer.spans, n)
	}
}
