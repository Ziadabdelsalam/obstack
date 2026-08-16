package mapping_test

import (
	"math"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/mapping"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
)

const workspaceID = "ws_test"

var (
	traceID = pcommon.TraceID{0x4b, 0xf9, 0x2f, 0x35, 0x77, 0xb3, 0x4d, 0xa6, 0xa3, 0xce, 0x92, 0x9d, 0x0e, 0x0e, 0x47, 0x36}
	spanID  = pcommon.SpanID{0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7}
	start   = time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
)

// newSpan returns a minimally valid span in a payload of its own, so a test only
// has to describe the attributes it cares about.
func newSpan(t *testing.T) (ptrace.Traces, ptrace.Span) {
	t.Helper()
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "demo-agent")
	span := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	span.SetTraceID(traceID)
	span.SetSpanID(spanID)
	span.SetName("span")
	span.SetStartTimestamp(pcommon.NewTimestampFromTime(start))
	span.SetEndTimestamp(pcommon.NewTimestampFromTime(start.Add(100 * time.Millisecond)))
	return td, span
}

func onlyRow(t *testing.T, td ptrace.Traces) mapping.SpanRow {
	t.Helper()
	rows := mapping.SpanRows(workspaceID, td)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	return rows[0]
}

// The classifier is the D8 contract every SDK and every foreign OTLP producer
// codes against, including the precedence between markers.
func TestLayerClassification(t *testing.T) {
	cases := []struct {
		name  string
		attrs map[string]string
		want  string
	}{
		{"llm", map[string]string{"gen_ai.system": "openai"}, mapping.LayerLLM},
		{"llm wins over agent", map[string]string{"gen_ai.request.model": "gpt-4o", "obstack.agent.step": "plan"}, mapping.LayerLLM},
		{"agent", map[string]string{"obstack.agent.step": "plan"}, mapping.LayerAgent},
		{"agent wins over tool", map[string]string{"obstack.agent.step": "plan", "obstack.tool.name": "search"}, mapping.LayerAgent},
		{"tool", map[string]string{"obstack.tool.name": "search"}, mapping.LayerTool},
		{"api by method", map[string]string{"http.request.method": "POST"}, mapping.LayerAPI},
		{"api by route", map[string]string{"http.route": "/chat"}, mapping.LayerAPI},
		{"other", map[string]string{"db.system": "postgresql"}, mapping.LayerOther},
		{"no attributes", nil, mapping.LayerOther},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			td, span := newSpan(t)
			for k, v := range tc.attrs {
				span.Attributes().PutStr(k, v)
			}
			if got := onlyRow(t, td).Layer; got != tc.want {
				t.Errorf("layer = %q, want %q", got, tc.want)
			}
		})
	}
}

// Regression pin (D42): the span-attribute form is the obstack-SDK convention
// and must keep working unchanged now that logs.go also extracts the
// log-record form — the two wire forms are mapped by independent code paths.
func TestGenAIExtractionAndCost(t *testing.T) {
	td, span := newSpan(t)
	attrs := span.Attributes()
	attrs.PutStr("gen_ai.system", "openai")
	attrs.PutStr("gen_ai.request.model", "gpt-4o-mini")
	attrs.PutStr("gen_ai.response.model", "gpt-4o-mini-2024-07-18")
	attrs.PutInt("gen_ai.usage.input_tokens", 1000)
	attrs.PutInt("gen_ai.usage.output_tokens", 500)
	attrs.PutStr("gen_ai.prompt", "what is obstack?")
	attrs.PutStr("gen_ai.completion", "an observability stack")
	attrs.PutStr("gen_ai.response.finish_reason", "stop")

	row := onlyRow(t, td)
	if row.Layer != mapping.LayerLLM {
		t.Fatalf("layer = %q, want llm", row.Layer)
	}
	if row.GenAISystem != "openai" || row.GenAIRequestModel != "gpt-4o-mini" || row.GenAIResponseModel != "gpt-4o-mini-2024-07-18" {
		t.Errorf("gen_ai columns = %q/%q/%q", row.GenAISystem, row.GenAIRequestModel, row.GenAIResponseModel)
	}
	if row.InputTokens != 1000 || row.OutputTokens != 500 {
		t.Errorf("tokens = %d/%d, want 1000/500", row.InputTokens, row.OutputTokens)
	}
	if row.Prompt != "what is obstack?" || row.Completion != "an observability stack" {
		t.Errorf("prompt/completion = %q/%q", row.Prompt, row.Completion)
	}
	if row.FinishReason != "stop" {
		t.Errorf("finish_reason = %q, want stop", row.FinishReason)
	}
	// gpt-4o-mini: $0.15 / $0.60 per Mtok.
	want := 1000*0.15/1e6 + 500*0.60/1e6
	if math.Abs(row.CostUSD-want) > 1e-12 {
		t.Errorf("cost_usd = %v, want %v", row.CostUSD, want)
	}

	// The two big payload fields live in their own ZSTD columns; a second copy
	// in the attributes map would double the row for nothing.
	if _, ok := row.Attributes["gen_ai.prompt"]; ok {
		t.Error("gen_ai.prompt is duplicated into the attributes map")
	}
	if _, ok := row.Attributes["gen_ai.completion"]; ok {
		t.Error("gen_ai.completion is duplicated into the attributes map")
	}
	if row.Attributes["gen_ai.system"] != "openai" {
		t.Error("attributes map lost gen_ai.system")
	}
}

// Token counts arrive as ints, doubles or strings depending on the SDK and the
// transport encoding.
func TestTokenCountsFromAnyWireType(t *testing.T) {
	td, span := newSpan(t)
	attrs := span.Attributes()
	attrs.PutStr("gen_ai.request.model", "gpt-4o-mini")
	attrs.PutStr("gen_ai.usage.input_tokens", "42")
	attrs.PutDouble("gen_ai.usage.output_tokens", 7)

	row := onlyRow(t, td)
	if row.InputTokens != 42 || row.OutputTokens != 7 {
		t.Errorf("tokens = %d/%d, want 42/7", row.InputTokens, row.OutputTokens)
	}
}

// Semconv turned the finish reason into an array; the column holds one value.
func TestFinishReasonFromArray(t *testing.T) {
	td, span := newSpan(t)
	span.Attributes().PutStr("gen_ai.request.model", "gpt-4o-mini")
	reasons := span.Attributes().PutEmptySlice("gen_ai.response.finish_reasons")
	reasons.AppendEmpty().SetStr("length")

	if got := onlyRow(t, td).FinishReason; got != "length" {
		t.Errorf("finish_reason = %q, want length", got)
	}
}

func TestUnpricedModelCostsZeroAndCounts(t *testing.T) {
	counter := metrics.UnpricedModels.WithLabelValues("acme-llm-9")
	before := testutil.ToFloat64(counter)

	td, span := newSpan(t)
	span.Attributes().PutStr("gen_ai.request.model", "acme-llm-9")
	span.Attributes().PutInt("gen_ai.usage.input_tokens", 1000)

	row := onlyRow(t, td)
	if row.CostUSD != 0 {
		t.Errorf("cost_usd = %v, want 0", row.CostUSD)
	}
	if delta := testutil.ToFloat64(counter) - before; delta != 1 {
		t.Errorf("unpriced counter delta = %v, want 1", delta)
	}
}

// A span carrying a model attribute but no gen_ai marker is not an LLM call, and
// must not appear as a hole in the price table either.
func TestNonLLMSpanIsNotPriced(t *testing.T) {
	td, span := newSpan(t)
	span.Attributes().PutStr("obstack.tool.name", "search")
	span.Attributes().PutStr("model", "acme-llm-9")

	row := onlyRow(t, td)
	if row.Layer != mapping.LayerTool {
		t.Fatalf("layer = %q, want tool", row.Layer)
	}
	if row.CostUSD != 0 || row.GenAIRequestModel != "" {
		t.Errorf("non-LLM span was priced: cost=%v model=%q", row.CostUSD, row.GenAIRequestModel)
	}
}

func TestSpanColumnsFromResourceAndSpan(t *testing.T) {
	td, span := newSpan(t)
	res := td.ResourceSpans().At(0).Resource().Attributes()
	res.PutStr("k8s.namespace.name", "obstack")
	res.PutStr("k8s.pod.name", "demo-agent-abc")
	res.PutStr("k8s.container.name", "app")
	res.PutStr("k8s.node.name", "node-1")
	span.SetKind(ptrace.SpanKindServer)
	span.SetParentSpanID(pcommon.SpanID{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08})
	span.Status().SetCode(ptrace.StatusCodeError)
	span.Status().SetMessage("boom")
	span.Attributes().PutInt("http.response.status_code", 500)

	row := onlyRow(t, td)
	if row.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" || row.SpanID != "00f067aa0ba902b7" {
		t.Errorf("ids = %q/%q", row.TraceID, row.SpanID)
	}
	if row.ParentSpanID != "0102030405060708" {
		t.Errorf("parent_span_id = %q", row.ParentSpanID)
	}
	if row.Kind != "server" || row.StatusCode != "error" || row.StatusMessage != "boom" {
		t.Errorf("kind/status = %q/%q/%q", row.Kind, row.StatusCode, row.StatusMessage)
	}
	if row.Service != "demo-agent" {
		t.Errorf("service = %q", row.Service)
	}
	if row.DurationNS != uint64(100*time.Millisecond) {
		t.Errorf("duration_ns = %d, want %d", row.DurationNS, 100*time.Millisecond)
	}
	if !row.StartTime.Equal(start) {
		t.Errorf("start_time = %s, want %s", row.StartTime, start)
	}
	if row.K8sNamespace != "obstack" || row.K8sPod != "demo-agent-abc" || row.K8sContainer != "app" || row.K8sNode != "node-1" {
		t.Errorf("k8s columns = %q/%q/%q/%q", row.K8sNamespace, row.K8sPod, row.K8sContainer, row.K8sNode)
	}
	// Non-string attribute values are stringified, not lost.
	if row.Attributes["http.response.status_code"] != "500" {
		t.Errorf("attributes = %v", row.Attributes)
	}
	if row.ResourceAttributes["service.name"] != "demo-agent" {
		t.Errorf("resource_attributes = %v", row.ResourceAttributes)
	}
}

// A root span's parent id must be the empty string: the summary materialized
// view identifies roots with parent_span_id = ”.
func TestRootSpanHasEmptyParent(t *testing.T) {
	td, _ := newSpan(t)
	if got := onlyRow(t, td).ParentSpanID; got != "" {
		t.Errorf("parent_span_id = %q, want empty", got)
	}
}

func TestUnmappableSpansAreDroppedAndCounted(t *testing.T) {
	counter := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonMapping)
	before := testutil.ToFloat64(counter)

	td := ptrace.NewTraces()
	spans := td.ResourceSpans().AppendEmpty().ScopeSpans().AppendEmpty().Spans()

	noTrace := spans.AppendEmpty()
	noTrace.SetSpanID(spanID)
	noTrace.SetStartTimestamp(pcommon.NewTimestampFromTime(start))

	noSpanID := spans.AppendEmpty()
	noSpanID.SetTraceID(traceID)
	noSpanID.SetStartTimestamp(pcommon.NewTimestampFromTime(start))

	noStart := spans.AppendEmpty()
	noStart.SetTraceID(traceID)
	noStart.SetSpanID(spanID)

	good := spans.AppendEmpty()
	good.SetTraceID(traceID)
	good.SetSpanID(spanID)
	good.SetName("keeper")
	good.SetStartTimestamp(pcommon.NewTimestampFromTime(start))

	rows := mapping.SpanRows(workspaceID, td)
	if len(rows) != 1 || rows[0].Name != "keeper" {
		t.Fatalf("got %d rows, want the one mappable span", len(rows))
	}
	if delta := testutil.ToFloat64(counter) - before; delta != 3 {
		t.Errorf("mapping drop delta = %v, want 3", delta)
	}
}

func TestLogRows(t *testing.T) {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "demo-agent")
	rl.Resource().Attributes().PutStr("k8s.pod.name", "demo-agent-abc")

	record := rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	record.SetTimestamp(pcommon.NewTimestampFromTime(start))
	record.SetSeverityNumber(plog.SeverityNumberWarn)
	record.SetSeverityText("WARN")
	record.Body().SetStr("tool call timed out")
	record.SetTraceID(traceID)
	record.SetSpanID(spanID)
	record.Attributes().PutStr("code.function", "call_tool")

	rows := mapping.LogRows(workspaceID, ld)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	row := rows[0]
	if row.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" || row.SpanID != "00f067aa0ba902b7" {
		t.Errorf("trace context = %q/%q", row.TraceID, row.SpanID)
	}
	if row.SeverityNumber != uint8(plog.SeverityNumberWarn) || row.SeverityText != "WARN" {
		t.Errorf("severity = %d/%q", row.SeverityNumber, row.SeverityText)
	}
	if row.Body != "tool call timed out" || row.Service != "demo-agent" || row.K8sPod != "demo-agent-abc" {
		t.Errorf("row = %+v", row)
	}
	if !row.Timestamp.Equal(start) {
		t.Errorf("timestamp = %s, want %s", row.Timestamp, start)
	}
	if row.Attributes["code.function"] != "call_tool" {
		t.Errorf("attributes = %v", row.Attributes)
	}
}

func TestLogTimestampFallsBackToObserved(t *testing.T) {
	ld := plog.NewLogs()
	record := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	record.SetObservedTimestamp(pcommon.NewTimestampFromTime(start))
	record.Body().SetStr("no wall clock here")

	rows := mapping.LogRows(workspaceID, ld)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	if !rows[0].Timestamp.Equal(start) {
		t.Errorf("timestamp = %s, want observed %s", rows[0].Timestamp, start)
	}
	if rows[0].TraceID != "" {
		t.Errorf("trace_id = %q, want empty for a log with no span context", rows[0].TraceID)
	}
}

// The message-array shape below is what upstream's Events API sends as the
// gen_ai.input.messages / gen_ai.output.messages attribute value, per OTel
// semantic conventions gen-ai-events, rev v1.37.0 (2025-09):
// https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/. The fill
// rule takes the attribute's string form verbatim, so the exact shape is not
// load-bearing for this package — only that it round-trips unchanged.
const (
	inputMessagesFixture  = `[{"role":"user","parts":[{"type":"text","content":"summarise the incident"}]}]`
	outputMessagesFixture = `[{"role":"assistant","parts":[{"type":"text","content":"the checkout service timed out"}]}]`
)

// D38 FINAL / D42: the log-record wire form. A log record carrying either
// content attribute fills the row's prompt/completion unconditionally — logs
// get no layer gate — and a record with no narrative text still lands with an
// honest empty body rather than one borrowed from the content.
func TestLogRecordFillsPromptCompletionFromMessages(t *testing.T) {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "demo-agent")

	record := rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	record.SetTimestamp(pcommon.NewTimestampFromTime(start))
	record.SetTraceID(traceID)
	record.SetSpanID(spanID)
	record.Attributes().PutStr("gen_ai.input.messages", inputMessagesFixture)
	record.Attributes().PutStr("gen_ai.output.messages", outputMessagesFixture)

	rows := mapping.LogRows(workspaceID, ld)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	row := rows[0]

	if row.Prompt != inputMessagesFixture {
		t.Errorf("prompt = %q, want %q", row.Prompt, inputMessagesFixture)
	}
	if row.Completion != outputMessagesFixture {
		t.Errorf("completion = %q, want %q", row.Completion, outputMessagesFixture)
	}
	if row.Body != "" {
		t.Errorf("body = %q, want empty — this record carries structured content, not narrative text", row.Body)
	}

	// D8 amendment extended to logs: the source attributes are not duplicated
	// into the uncompressed Map.
	if _, ok := row.Attributes["gen_ai.input.messages"]; ok {
		t.Error("gen_ai.input.messages is duplicated into the attributes map")
	}
	if _, ok := row.Attributes["gen_ai.output.messages"]; ok {
		t.Error("gen_ai.output.messages is duplicated into the attributes map")
	}
}

// A record carrying neither content attribute is the overwhelming majority
// case (an ordinary log line) and must not gain phantom content.
func TestLogRecordWithoutContentAttributesLeavesPromptCompletionEmpty(t *testing.T) {
	ld := plog.NewLogs()
	record := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	record.SetTimestamp(pcommon.NewTimestampFromTime(start))
	record.Body().SetStr("tool call timed out")

	rows := mapping.LogRows(workspaceID, ld)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	if rows[0].Prompt != "" || rows[0].Completion != "" {
		t.Errorf("prompt/completion = %q/%q, want both empty", rows[0].Prompt, rows[0].Completion)
	}
}

func TestUntimedLogIsDroppedAndCounted(t *testing.T) {
	counter := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonMapping)
	before := testutil.ToFloat64(counter)

	ld := plog.NewLogs()
	record := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	record.Body().SetStr("when did this happen?")

	if rows := mapping.LogRows(workspaceID, ld); len(rows) != 0 {
		t.Fatalf("got %d rows, want 0", len(rows))
	}
	if delta := testutil.ToFloat64(counter) - before; delta != 1 {
		t.Errorf("mapping drop delta = %v, want 1", delta)
	}
}
