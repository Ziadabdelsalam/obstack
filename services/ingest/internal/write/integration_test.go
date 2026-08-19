package write

import (
	"context"
	"fmt"
	"math"
	"os"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/mapping"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/migrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/migrations"
)

// These tests run against a real ClickHouse — the compose stack from
// deploy/compose by default, overridable for CI. Nothing here is faked: a writer
// is only correct if the server accepts every column's type, and the summary
// rollup only exists in ClickHouse.
const (
	defaultDSN         = "clickhouse://obstack_ingest:obstack_ingest_dev@127.0.0.1:9000/obstack"
	defaultReadonlyDSN = "clickhouse://obstack_web:obstack_web_dev@127.0.0.1:9000/obstack"
)

func testDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_CLICKHOUSE_DSN"); dsn != "" {
		return dsn
	}
	return defaultDSN
}

func readonlyTestDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_CLICKHOUSE_READONLY_DSN"); dsn != "" {
		return dsn
	}
	return defaultReadonlyDSN
}

// connect opens the assertion connection and makes sure the schema is there. It
// skips rather than fails when no server is reachable: a laptop without the
// compose stack up should not report a broken writer.
func connect(t *testing.T) driver.Conn {
	t.Helper()

	opts, err := clickhouse.ParseDSN(testDSN())
	if err != nil {
		t.Fatalf("parse test DSN: %v", err)
	}
	conn, err := clickhouse.Open(opts)
	if err != nil {
		t.Fatalf("open clickhouse: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Ping(ctx); err != nil {
		conn.Close()
		t.Skipf("no ClickHouse at %s (%v); start deploy/compose to run the writer integration tests", testDSN(), err)
	}
	t.Cleanup(func() { conn.Close() })

	if _, err := migrate.Run(ctx, testDSN(), migrations.FS); err != nil {
		t.Fatalf("apply schema: %v", err)
	}
	return conn
}

// newWorkspace gives each test its own workspace_id, which is the leading
// ordering-key column: tests never see each other's rows and clean up after
// themselves.
func newWorkspace(t *testing.T, conn driver.Conn) string {
	t.Helper()
	workspaceID := fmt.Sprintf("ws_it_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, table := range []string{"spans", "logs", "trace_summaries"} {
			if err := conn.Exec(ctx,
				"ALTER TABLE obstack."+table+" DELETE WHERE workspace_id = ?", workspaceID); err != nil {
				t.Logf("cleanup of %s for %s: %v", table, workspaceID, err)
			}
		}
	})
	return workspaceID
}

// newWriter builds a writer against the test server. The flush interval is short
// so a test that waits for the timer does not wait a second.
func newWriter(t *testing.T) *Writer {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	w, err := New(ctx, Config{DSN: testDSN(), FlushInterval: 100 * time.Millisecond})
	if err != nil {
		t.Fatalf("new writer: %v", err)
	}
	return w
}

func newTraceID(b byte) pcommon.TraceID {
	id := pcommon.TraceID{0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18, 0x29, 0x3a, 0x4b, 0x5c, 0x6d, 0x7e, 0x8f, 0x90}
	id[15] = b
	return id
}

func newSpanID(b byte) pcommon.SpanID {
	return pcommon.SpanID{0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, b}
}

// fixture is the shape the demo app emits (D15): an API span with an agent step
// under it, a tool call, and two LLM calls — one priced by the embedded table,
// one not.
func fixture(traceID pcommon.TraceID, base time.Time) ptrace.Traces {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	res := rs.Resource().Attributes()
	res.PutStr("service.name", "demo-agent")
	res.PutStr("k8s.namespace.name", "obstack")
	res.PutStr("k8s.pod.name", "demo-agent-7c9f")
	res.PutStr("k8s.container.name", "app")
	res.PutStr("k8s.node.name", "node-1")
	spans := rs.ScopeSpans().AppendEmpty().Spans()

	newSpan := func(name string, id, parent pcommon.SpanID, offset, duration time.Duration) ptrace.Span {
		s := spans.AppendEmpty()
		s.SetTraceID(traceID)
		s.SetSpanID(id)
		if parent != (pcommon.SpanID{}) {
			s.SetParentSpanID(parent)
		}
		s.SetName(name)
		s.SetStartTimestamp(pcommon.NewTimestampFromTime(base.Add(offset)))
		s.SetEndTimestamp(pcommon.NewTimestampFromTime(base.Add(offset + duration)))
		return s
	}

	root := newSpan("POST /chat", newSpanID(0x01), pcommon.SpanID{}, 0, 900*time.Millisecond)
	root.SetKind(ptrace.SpanKindServer)
	root.Status().SetCode(ptrace.StatusCodeOk)
	root.Attributes().PutStr("http.request.method", "POST")
	root.Attributes().PutStr("http.route", "/chat")
	root.Attributes().PutInt("http.response.status_code", 200)

	agent := newSpan("agent step: plan", newSpanID(0x02), newSpanID(0x01), 10*time.Millisecond, 800*time.Millisecond)
	agent.Attributes().PutStr("obstack.agent.step", "plan")

	tool := newSpan("tool: search", newSpanID(0x03), newSpanID(0x02), 20*time.Millisecond, 100*time.Millisecond)
	tool.SetKind(ptrace.SpanKindClient)
	tool.Attributes().PutStr("obstack.tool.name", "search")

	llm := newSpan("chat gpt-4o-mini", newSpanID(0x04), newSpanID(0x02), 150*time.Millisecond, 600*time.Millisecond)
	llm.SetKind(ptrace.SpanKindInternal)
	llmAttrs := llm.Attributes()
	llmAttrs.PutStr("gen_ai.system", "openai")
	llmAttrs.PutStr("gen_ai.request.model", "gpt-4o-mini")
	llmAttrs.PutStr("gen_ai.response.model", "gpt-4o-mini-2024-07-18")
	llmAttrs.PutInt("gen_ai.usage.input_tokens", 1200)
	llmAttrs.PutInt("gen_ai.usage.output_tokens", 340)
	llmAttrs.PutStr("gen_ai.prompt", "summarise the incident")
	llmAttrs.PutStr("gen_ai.completion", "the checkout service timed out")
	llmAttrs.PutStr("gen_ai.response.finish_reason", "stop")

	unpriced := newSpan("chat acme-llm-9", newSpanID(0x05), newSpanID(0x02), 160*time.Millisecond, 50*time.Millisecond)
	unpriced.Attributes().PutStr("gen_ai.system", "acme")
	unpriced.Attributes().PutStr("gen_ai.request.model", unpricedModel)
	unpriced.Attributes().PutInt("gen_ai.usage.input_tokens", 10)

	return td
}

// unpricedModel is deliberately absent from pricing/prices.json.
const unpricedModel = "acme-llm-does-not-exist"

func logFixture(traceID pcommon.TraceID, at time.Time) plog.Logs {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "demo-agent")
	rl.Resource().Attributes().PutStr("k8s.pod.name", "demo-agent-7c9f")

	record := rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	record.SetTimestamp(pcommon.NewTimestampFromTime(at))
	record.SetSeverityNumber(plog.SeverityNumberInfo)
	record.SetSeverityText("INFO")
	record.Body().SetStr("handled chat request")
	record.SetTraceID(traceID)
	record.SetSpanID(newSpanID(0x01))
	record.Attributes().PutStr("code.function", "chat")

	return ld
}

// The message-array shape below is what upstream's Events API sends as the
// gen_ai.input.messages / gen_ai.output.messages attribute value, per OTel
// semantic conventions gen-ai-events, rev v1.37.0 (2025-09):
// https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/.
const (
	inputMessagesFixture  = `[{"role":"user","parts":[{"type":"text","content":"summarise the incident"}]}]`
	outputMessagesFixture = `[{"role":"assistant","parts":[{"type":"text","content":"the checkout service timed out"}]}]`
)

// contentLogFixture is the log-record wire form (D38 FINAL / D42): a record
// carrying gen_ai.input.messages/gen_ai.output.messages rather than narrative
// text, tied to an LLM span by trace_id/span_id.
func contentLogFixture(traceID pcommon.TraceID, spanID pcommon.SpanID, at time.Time) plog.Logs {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "demo-agent")
	rl.Resource().Attributes().PutStr("k8s.pod.name", "demo-agent-7c9f")

	record := rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	record.SetTimestamp(pcommon.NewTimestampFromTime(at))
	record.SetSeverityNumber(plog.SeverityNumberInfo)
	record.SetTraceID(traceID)
	record.SetSpanID(spanID)
	record.Attributes().PutStr("gen_ai.input.messages", inputMessagesFixture)
	record.Attributes().PutStr("gen_ai.output.messages", outputMessagesFixture)

	return ld
}

// TestWriterLandsLogRecordGenAIContent is the D42(e) probes 1-2 test: it lands
// a log-record-form content row through the real writer and reads it back
// from ClickHouse, asserting both that the columns are filled and that the
// source attributes never reach the Map.
//
// probe 1 (falsification, run manually and reverted — not a permanent
// toggle): comment out the skip args on flattenAttributes in
// internal/mapping/logs.go so gen_ai.input.messages/gen_ai.output.messages
// land in the row's Map too, and the "duplicated" assertions below go red.
//
// probe 2 (falsification, same method): stop mapLogRecord from setting
// Prompt/Completion in internal/mapping/logs.go, and the prompt/completion
// assertions below go red — proving the fill is real, not a coincidence of
// zero values.
func TestWriterLandsLogRecordGenAIContent(t *testing.T) {
	conn := connect(t)
	workspaceID := newWorkspace(t, conn)
	ctx := context.Background()

	traceID := newTraceID(0x06)
	spanID := newSpanID(0x04)
	at := time.Now().UTC().Add(-time.Minute)

	w := newWriter(t)
	w.ConsumeLogs(ctx, workspaceID, contentLogFixture(traceID, spanID, at))
	if err := w.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	var (
		prompt, completion, body string
		attributes               map[string]string
	)
	if err := conn.QueryRow(ctx, `
		SELECT prompt, completion, body, attributes
		FROM obstack.logs WHERE workspace_id = ? AND trace_id = ? AND span_id = ?`,
		workspaceID, traceID.String(), spanID.String(),
	).Scan(&prompt, &completion, &body, &attributes); err != nil {
		t.Fatalf("read content log: %v", err)
	}

	if prompt != inputMessagesFixture {
		t.Errorf("prompt = %q, want %q", prompt, inputMessagesFixture)
	}
	if completion != outputMessagesFixture {
		t.Errorf("completion = %q, want %q", completion, outputMessagesFixture)
	}
	if body != "" {
		t.Errorf("body = %q, want empty — an honest fill for a content-only record", body)
	}
	if _, ok := attributes["gen_ai.input.messages"]; ok {
		t.Error("gen_ai.input.messages is duplicated into the landed attributes map")
	}
	if _, ok := attributes["gen_ai.output.messages"]; ok {
		t.Error("gen_ai.output.messages is duplicated into the landed attributes map")
	}
}

func TestWriterLandsMappedFixture(t *testing.T) {
	conn := connect(t)
	workspaceID := newWorkspace(t, conn)
	ctx := context.Background()

	traceID := newTraceID(0x01)
	base := time.Now().UTC().Add(-time.Minute)
	beforeUnpriced := metrics.UnpricedModelCounts()[unpricedModel]

	w := newWriter(t)
	w.ConsumeTraces(ctx, workspaceID, fixture(traceID, base))
	w.ConsumeLogs(ctx, workspaceID, logFixture(traceID, base.Add(50*time.Millisecond)))
	if err := w.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	// D22: every row carries an explicitly set layer, and nothing the fixture
	// describes falls through to the catch-all.
	rows, err := conn.Query(ctx,
		"SELECT layer, count() FROM obstack.spans WHERE workspace_id = ? GROUP BY layer", workspaceID)
	if err != nil {
		t.Fatalf("query layers: %v", err)
	}
	defer rows.Close()
	layers := map[string]uint64{}
	for rows.Next() {
		var layer string
		var n uint64
		if err := rows.Scan(&layer, &n); err != nil {
			t.Fatalf("scan layer: %v", err)
		}
		layers[layer] = n
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("layer rows: %v", err)
	}
	want := map[string]uint64{"api": 1, "agent": 1, "tool": 1, "llm": 2}
	if len(layers) != len(want) {
		t.Fatalf("layers = %v, want %v", layers, want)
	}
	for layer, n := range want {
		if layers[layer] != n {
			t.Errorf("layer %s = %d rows, want %d", layer, layers[layer], n)
		}
	}
	if n := layers[mapping.LayerOther]; n != 0 {
		t.Errorf("%d rows landed as 'other'; every mapped span must set its layer", n)
	}

	// The LLM row is the one carrying every first-class GenAI column.
	var (
		name, kind, service, status         string
		parent, system, reqModel, respModel string
		finish, prompt, completion          string
		startTime                           time.Time
		durationNS                          uint64
		inputTokens, outputTokens           uint32
		cost                                float64
		namespace, pod, container, node     string
		attributes, resourceAttributes      map[string]string
	)
	err = conn.QueryRow(ctx, `
		SELECT name, kind, service, status_code, parent_span_id, start_time, duration_ns,
		       gen_ai_system, gen_ai_request_model, gen_ai_response_model,
		       input_tokens, output_tokens, cost_usd, finish_reason, prompt, completion,
		       k8s_namespace, k8s_pod, k8s_container, k8s_node, attributes, resource_attributes
		FROM obstack.spans
		WHERE workspace_id = ? AND trace_id = ? AND span_id = ?`,
		workspaceID, traceID.String(), newSpanID(0x04).String(),
	).Scan(&name, &kind, &service, &status, &parent, &startTime, &durationNS,
		&system, &reqModel, &respModel, &inputTokens, &outputTokens, &cost, &finish, &prompt, &completion,
		&namespace, &pod, &container, &node, &attributes, &resourceAttributes)
	if err != nil {
		t.Fatalf("read llm span: %v", err)
	}

	if name != "chat gpt-4o-mini" || kind != "internal" || service != "demo-agent" || status != "unset" {
		t.Errorf("span identity = %q/%q/%q/%q", name, kind, service, status)
	}
	if parent != newSpanID(0x02).String() {
		t.Errorf("parent_span_id = %q", parent)
	}
	if wantStart := base.Add(150 * time.Millisecond); !startTime.Equal(wantStart) {
		t.Errorf("start_time = %s, want %s", startTime, wantStart)
	}
	if durationNS != uint64(600*time.Millisecond) {
		t.Errorf("duration_ns = %d, want %d", durationNS, 600*time.Millisecond)
	}
	if system != "openai" || reqModel != "gpt-4o-mini" || respModel != "gpt-4o-mini-2024-07-18" {
		t.Errorf("gen_ai columns = %q/%q/%q", system, reqModel, respModel)
	}
	if inputTokens != 1200 || outputTokens != 340 {
		t.Errorf("tokens = %d/%d, want 1200/340", inputTokens, outputTokens)
	}
	if finish != "stop" || prompt != "summarise the incident" || completion != "the checkout service timed out" {
		t.Errorf("finish/prompt/completion = %q/%q/%q", finish, prompt, completion)
	}
	// gpt-4o-mini: $0.15 / $0.60 per Mtok (D9).
	wantCost := 1200*0.15/1e6 + 340*0.60/1e6
	if math.Abs(cost-wantCost) > 1e-12 {
		t.Errorf("cost_usd = %v, want %v", cost, wantCost)
	}
	if namespace != "obstack" || pod != "demo-agent-7c9f" || container != "app" || node != "node-1" {
		t.Errorf("k8s columns = %q/%q/%q/%q", namespace, pod, container, node)
	}
	if attributes["gen_ai.system"] != "openai" {
		t.Errorf("attributes = %v", attributes)
	}
	if _, dup := attributes["gen_ai.prompt"]; dup {
		t.Error("prompt is stored twice: once in its own column and once in attributes")
	}
	if resourceAttributes["service.name"] != "demo-agent" {
		t.Errorf("resource_attributes = %v", resourceAttributes)
	}

	// The API root keeps http.request.method in attributes, which is what the
	// summary view reads for root_method.
	var rootMethod string
	if err := conn.QueryRow(ctx,
		"SELECT attributes['http.request.method'] FROM obstack.spans WHERE workspace_id = ? AND parent_span_id = ''",
		workspaceID).Scan(&rootMethod); err != nil {
		t.Fatalf("read root span: %v", err)
	}
	if rootMethod != "POST" {
		t.Errorf("root http.request.method = %q, want POST", rootMethod)
	}

	// D9: a model the table does not know costs nothing and is counted, so the
	// gap is visible instead of showing up as a suspiciously cheap call.
	var unpricedCost float64
	if err := conn.QueryRow(ctx,
		"SELECT cost_usd FROM obstack.spans WHERE workspace_id = ? AND gen_ai_request_model = ?",
		workspaceID, unpricedModel).Scan(&unpricedCost); err != nil {
		t.Fatalf("read unpriced span: %v", err)
	}
	if unpricedCost != 0 {
		t.Errorf("unpriced cost_usd = %v, want 0", unpricedCost)
	}
	if delta := metrics.UnpricedModelCounts()[unpricedModel] - beforeUnpriced; delta != 1 {
		t.Errorf("unpriced model counter delta = %v, want 1", delta)
	}

	// The log lands with the trace context that ties it to the waterfall.
	var (
		logTraceID, logSpanID, severityText, body, logService string
		severityNumber                                        uint8
		logAttrs                                              map[string]string
	)
	if err := conn.QueryRow(ctx, `
		SELECT trace_id, span_id, severity_number, severity_text, body, service, attributes
		FROM obstack.logs WHERE workspace_id = ?`, workspaceID,
	).Scan(&logTraceID, &logSpanID, &severityNumber, &severityText, &body, &logService, &logAttrs); err != nil {
		t.Fatalf("read log: %v", err)
	}
	if logTraceID != traceID.String() || logSpanID != newSpanID(0x01).String() {
		t.Errorf("log trace context = %q/%q", logTraceID, logSpanID)
	}
	if severityNumber != uint8(plog.SeverityNumberInfo) || severityText != "INFO" || body != "handled chat request" {
		t.Errorf("log severity/body = %d/%q/%q", severityNumber, severityText, body)
	}
	if logService != "demo-agent" || logAttrs["code.function"] != "chat" {
		t.Errorf("log service/attributes = %q/%v", logService, logAttrs)
	}
}

// The root span routinely arrives after its children — it ends last, so its
// exporter batch is later. The summary must still name the trace correctly once
// the parts are merged (D7's query rule).
func TestSummaryRollupWithRootInSecondBatch(t *testing.T) {
	conn := connect(t)
	workspaceID := newWorkspace(t, conn)
	ctx := context.Background()

	traceID := newTraceID(0x02)
	base := time.Now().UTC().Add(-time.Minute)

	children := ptrace.NewTraces()
	rs := children.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "demo-agent")
	spans := rs.ScopeSpans().AppendEmpty().Spans()

	llm := spans.AppendEmpty()
	llm.SetTraceID(traceID)
	llm.SetSpanID(newSpanID(0x12))
	llm.SetParentSpanID(newSpanID(0x11))
	llm.SetName("chat gpt-4o-mini")
	llm.SetStartTimestamp(pcommon.NewTimestampFromTime(base.Add(100 * time.Millisecond)))
	llm.SetEndTimestamp(pcommon.NewTimestampFromTime(base.Add(700 * time.Millisecond)))
	llm.Attributes().PutStr("gen_ai.request.model", "gpt-4o-mini")
	llm.Attributes().PutInt("gen_ai.usage.input_tokens", 1000)
	llm.Attributes().PutInt("gen_ai.usage.output_tokens", 200)

	failed := spans.AppendEmpty()
	failed.SetTraceID(traceID)
	failed.SetSpanID(newSpanID(0x13))
	failed.SetParentSpanID(newSpanID(0x11))
	failed.SetName("tool: search")
	failed.SetStartTimestamp(pcommon.NewTimestampFromTime(base.Add(20 * time.Millisecond)))
	failed.SetEndTimestamp(pcommon.NewTimestampFromTime(base.Add(60 * time.Millisecond)))
	failed.Attributes().PutStr("obstack.tool.name", "search")
	failed.Status().SetCode(ptrace.StatusCodeError)

	// Two writers means two INSERT blocks, so the summary table holds two
	// partial aggregates for this trace — exactly the case the -Merge query rule
	// exists for.
	first := newWriter(t)
	first.ConsumeTraces(ctx, workspaceID, children)
	if err := first.Close(); err != nil {
		t.Fatalf("close first writer: %v", err)
	}

	roots := ptrace.NewTraces()
	rootRS := roots.ResourceSpans().AppendEmpty()
	rootRS.Resource().Attributes().PutStr("service.name", "demo-api")
	root := rootRS.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	root.SetTraceID(traceID)
	root.SetSpanID(newSpanID(0x11))
	root.SetName("POST /chat")
	root.SetKind(ptrace.SpanKindServer)
	root.SetStartTimestamp(pcommon.NewTimestampFromTime(base))
	root.SetEndTimestamp(pcommon.NewTimestampFromTime(base.Add(900 * time.Millisecond)))
	root.Attributes().PutStr("http.request.method", "POST")

	second := newWriter(t)
	second.ConsumeTraces(ctx, workspaceID, roots)
	if err := second.Close(); err != nil {
		t.Fatalf("close second writer: %v", err)
	}

	var (
		minStart, maxEnd          time.Time
		spanCount, errorCount     uint64
		inputTokens, outputTokens uint64
		totalCost                 float64
		services, models          []string
		rootName, rootMethod      string
	)
	err := conn.QueryRow(ctx, `
		SELECT min(min_start), max(max_end), sum(span_count), sum(error_count),
		       sum(total_input_tokens), sum(total_output_tokens), sum(total_cost_usd),
		       groupUniqArrayArray(services), groupUniqArrayArray(models),
		       argMinIfMerge(root_name), argMinIfMerge(root_method)
		FROM obstack.trace_summaries
		WHERE workspace_id = ? AND trace_id = ?
		GROUP BY workspace_id, trace_id`,
		workspaceID, traceID.String(),
	).Scan(&minStart, &maxEnd, &spanCount, &errorCount, &inputTokens, &outputTokens, &totalCost,
		&services, &models, &rootName, &rootMethod)
	if err != nil {
		t.Fatalf("read summary: %v", err)
	}

	if spanCount != 3 {
		t.Errorf("span_count = %d, want 3", spanCount)
	}
	if errorCount != 1 {
		t.Errorf("error_count = %d, want 1", errorCount)
	}
	if !minStart.Equal(base) {
		t.Errorf("min_start = %s, want the root's start %s", minStart, base)
	}
	if wantEnd := base.Add(900 * time.Millisecond); !maxEnd.Equal(wantEnd) {
		t.Errorf("max_end = %s, want %s", maxEnd, wantEnd)
	}
	if inputTokens != 1000 || outputTokens != 200 {
		t.Errorf("summary tokens = %d/%d, want 1000/200", inputTokens, outputTokens)
	}
	wantCost := 1000*0.15/1e6 + 200*0.60/1e6
	if math.Abs(totalCost-wantCost) > 1e-12 {
		t.Errorf("total_cost_usd = %v, want %v", totalCost, wantCost)
	}
	if rootName != "POST /chat" {
		t.Errorf("root_name = %q, want the span from the second batch", rootName)
	}
	if rootMethod != "POST" {
		t.Errorf("root_method = %q, want POST", rootMethod)
	}
	if len(services) != 2 {
		t.Errorf("services = %v, want both service names", services)
	}
	if len(models) != 1 || models[0] != "gpt-4o-mini" {
		t.Errorf("models = %v, want [gpt-4o-mini]", models)
	}
}

// D23: the OTLP response is earned at enqueue. A write the server refuses is
// retried, then dropped and counted — the client is never asked to re-send.
func TestWriteFailureIsCountedNotReturned(t *testing.T) {
	connect(t) // skip when there is no server to refuse us
	workspaceID := fmt.Sprintf("ws_it_ro_%d", time.Now().UnixNano())

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// The read-only web user (D11) cannot INSERT: a real server-side rejection,
	// not a stubbed error.
	w, err := New(ctx, Config{DSN: readonlyTestDSN(), FlushInterval: 100 * time.Millisecond})
	if err != nil {
		t.Fatalf("new writer against the read-only user: %v", err)
	}

	counter := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonWrite)
	before := testutil.ToFloat64(counter)

	// ConsumeTraces has no error to return, by design.
	w.ConsumeTraces(context.Background(), workspaceID, fixture(newTraceID(0x03), time.Now().UTC()))
	if err := w.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	if delta := testutil.ToFloat64(counter) - before; delta != 5 {
		t.Errorf("write drop delta = %v, want the 5 fixture spans", delta)
	}
}
