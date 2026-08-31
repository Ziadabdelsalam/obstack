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
	"go.opentelemetry.io/collector/pdata/pmetric"
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

// newWriterWithCap is newWriter with a D376 series cap a test can actually
// exhaust, rather than the production DefaultSeriesCap of 25,000 — proving
// Config.SeriesCap really reaches mapping.NewSeriesCache without generating
// that many series.
func newWriterWithCap(t *testing.T, cap int) *Writer {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	w, err := New(ctx, Config{DSN: testDSN(), FlushInterval: 100 * time.Millisecond, SeriesCap: cap})
	if err != nil {
		t.Fatalf("new writer with cap %d: %v", cap, err)
	}
	return w
}

// newMetricsWorkspace is newWorkspace for the D363 metrics tables: its own
// workspace_id so tests never see each other's series, cleaned up on the way
// out the same way newWorkspace cleans spans/logs/trace_summaries.
func newMetricsWorkspace(t *testing.T, conn driver.Conn) string {
	t.Helper()
	workspaceID := fmt.Sprintf("ws_it_metrics_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, table := range []string{"metric_points", "metric_points_1m", "metric_points_1h", "metric_series"} {
			if err := conn.Exec(ctx,
				"ALTER TABLE obstack."+table+" DELETE WHERE workspace_id = ?", workspaceID); err != nil {
				t.Logf("cleanup of %s for %s: %v", table, workspaceID, err)
			}
		}
	})
	return workspaceID
}

// gaugeMetric returns a payload holding one gauge metric with one data point.
func gaugeMetric(name string, value float64, ts time.Time) pmetric.Metrics {
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	rm.Resource().Attributes().PutStr("service.name", "demo-agent")
	metric := rm.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	metric.SetName(name)
	dp := metric.SetEmptyGauge().DataPoints().AppendEmpty()
	dp.SetDoubleValue(value)
	dp.SetTimestamp(pcommon.NewTimestampFromTime(ts))
	return md
}

// mixedMetricsExport builds one export carrying all three D363 temperaments
// under one resource: a gauge (emits every round), a cumulative monotonic sum
// (registers on round one, emits its delta from round two on) and a
// cumulative histogram (same). Passing the same startTime across rounds keeps
// both cumulative series on the non-reset path.
func mixedMetricsExport(ts, startTime time.Time, sumValue float64, bucketCounts []uint64, histSum float64, histCount uint64) pmetric.Metrics {
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	rm.Resource().Attributes().PutStr("service.name", "demo-agent")
	sm := rm.ScopeMetrics().AppendEmpty()

	gauge := sm.Metrics().AppendEmpty()
	gauge.SetName("it.queue.depth")
	gdp := gauge.SetEmptyGauge().DataPoints().AppendEmpty()
	gdp.SetDoubleValue(42)
	gdp.SetTimestamp(pcommon.NewTimestampFromTime(ts))

	sum := sm.Metrics().AppendEmpty()
	sum.SetName("it.requests.total")
	s := sum.SetEmptySum()
	s.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	s.SetIsMonotonic(true)
	sdp := s.DataPoints().AppendEmpty()
	sdp.SetDoubleValue(sumValue)
	sdp.SetStartTimestamp(pcommon.NewTimestampFromTime(startTime))
	sdp.SetTimestamp(pcommon.NewTimestampFromTime(ts))

	hist := sm.Metrics().AppendEmpty()
	hist.SetName("it.request.duration")
	h := hist.SetEmptyHistogram()
	h.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	hdp := h.DataPoints().AppendEmpty()
	hdp.ExplicitBounds().FromRaw([]float64{0.1, 0.5, 1})
	hdp.BucketCounts().FromRaw(bucketCounts)
	hdp.SetSum(histSum)
	hdp.SetCount(histCount)
	hdp.SetStartTimestamp(pcommon.NewTimestampFromTime(startTime))
	hdp.SetTimestamp(pcommon.NewTimestampFromTime(ts))

	return md
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
	if err := w.Close(ctx); err != nil {
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
	if err := w.Close(ctx); err != nil {
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
	if err := first.Close(ctx); err != nil {
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
	if err := second.Close(ctx); err != nil {
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
	if err := w.Close(ctx); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	if delta := testutil.ToFloat64(counter) - before; delta != 5 {
		t.Errorf("write drop delta = %v, want the 5 fixture spans", delta)
	}
}

// TestWriterLandsMappedMetricsFixture is T4's wiring proof for all three D363
// temperaments: ConsumeMetrics rides the same D5 batcher shape as
// spans/logs, and MetricRows' mapping (T2) lands correctly through it —
// rows in the raw table, the 1m rollup, and the catalog/cardinality source
// metric_series (packet §3).
func TestWriterLandsMappedMetricsFixture(t *testing.T) {
	conn := connect(t)
	workspaceID := newMetricsWorkspace(t, conn)
	ctx := context.Background()

	base := time.Now().UTC().Add(-5 * time.Minute)
	startTime := base.Add(-time.Hour)

	w := newWriter(t)
	// Round one: the cumulative sum and histogram register their baselines and
	// emit no row (D363 §1 first-observation rule) — only the gauge does.
	w.ConsumeMetrics(ctx, workspaceID, mixedMetricsExport(base, startTime, 1000, []uint64{5, 10, 3}, 18, 18))
	// Round two, a minute later: both cumulative series now emit their delta.
	w.ConsumeMetrics(ctx, workspaceID, mixedMetricsExport(base.Add(time.Minute), startTime, 1400, []uint64{7, 14, 5}, 26, 26))
	if err := w.Close(ctx); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	// Raw: 2 gauge rows (one per round) + 1 sum row + 1 histogram row (round
	// two only, per the first-observation rule) = 4.
	var rawRows uint64
	if err := conn.QueryRow(ctx,
		"SELECT count() FROM obstack.metric_points WHERE workspace_id = ?", workspaceID,
	).Scan(&rawRows); err != nil {
		t.Fatalf("count raw metric_points: %v", err)
	}
	if rawRows != 4 {
		t.Fatalf("raw metric_points rows = %d, want 4 (2 gauge + 1 sum delta + 1 histogram delta)", rawRows)
	}

	var sumDelta float64
	if err := conn.QueryRow(ctx,
		"SELECT value FROM obstack.metric_points WHERE workspace_id = ? AND name = 'it.requests.total'",
		workspaceID).Scan(&sumDelta); err != nil {
		t.Fatalf("read sum row: %v", err)
	}
	if sumDelta != 400 {
		t.Errorf("sum delta = %v, want 400 (1400-1000)", sumDelta)
	}

	var (
		bucketCounts []uint64
		hSum         float64
		hCount       uint64
	)
	if err := conn.QueryRow(ctx,
		"SELECT bucket_counts, h_sum, h_count FROM obstack.metric_points WHERE workspace_id = ? AND name = 'it.request.duration'",
		workspaceID).Scan(&bucketCounts, &hSum, &hCount); err != nil {
		t.Fatalf("read histogram row: %v", err)
	}
	wantCounts := []uint64{2, 4, 2}
	if len(bucketCounts) != len(wantCounts) {
		t.Fatalf("bucket_counts = %v, want %v", bucketCounts, wantCounts)
	}
	for i := range wantCounts {
		if bucketCounts[i] != wantCounts[i] {
			t.Errorf("bucket_counts = %v, want %v", bucketCounts, wantCounts)
		}
	}
	if hSum != 8 || hCount != 8 {
		t.Errorf("h_sum/h_count = %v/%v, want 8/8", hSum, hCount)
	}

	// The 1m rollup (packet §3): -Merge/plain-aggregate combinators matching
	// each column's declared aggregate function, grouped by series key —
	// never FINAL, never a bare SELECT.
	var rollupSum float64
	if err := conn.QueryRow(ctx, `
		SELECT sum(sum_delta) FROM obstack.metric_points_1m
		WHERE workspace_id = ? AND name = 'it.requests.total'
		GROUP BY workspace_id, name, series_hash`,
		workspaceID).Scan(&rollupSum); err != nil {
		t.Fatalf("read 1m sum rollup: %v", err)
	}
	if rollupSum != 400 {
		t.Errorf("1m rollup sum_delta = %v, want 400", rollupSum)
	}

	var (
		rollupCounts []uint64
		rollupHSum   float64
		rollupHCount uint64
	)
	if err := conn.QueryRow(ctx, `
		SELECT sumForEachMerge(hist_counts), sum(h_sum), sum(h_count) FROM obstack.metric_points_1m
		WHERE workspace_id = ? AND name = 'it.request.duration'
		GROUP BY workspace_id, name, series_hash`,
		workspaceID).Scan(&rollupCounts, &rollupHSum, &rollupHCount); err != nil {
		t.Fatalf("read 1m histogram rollup: %v", err)
	}
	if len(rollupCounts) != len(wantCounts) {
		t.Fatalf("1m rollup hist_counts = %v, want %v", rollupCounts, wantCounts)
	}
	for i := range wantCounts {
		if rollupCounts[i] != wantCounts[i] {
			t.Errorf("1m rollup hist_counts = %v, want %v", rollupCounts, wantCounts)
		}
	}
	if rollupHSum != 8 || rollupHCount != 8 {
		t.Errorf("1m rollup h_sum/h_count = %v/%v, want 8/8", rollupHSum, rollupHCount)
	}

	// metric_series: the catalog/cardinality source (packet §3) — one row per
	// series, keyed by (name, series_hash), typed correctly.
	rows, err := conn.Query(ctx,
		"SELECT name, type FROM obstack.metric_series WHERE workspace_id = ? ORDER BY name", workspaceID)
	if err != nil {
		t.Fatalf("query metric_series: %v", err)
	}
	defer rows.Close()
	types := map[string]string{}
	for rows.Next() {
		var name, mtype string
		if err := rows.Scan(&name, &mtype); err != nil {
			t.Fatalf("scan metric_series: %v", err)
		}
		types[name] = mtype
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("metric_series rows: %v", err)
	}
	wantTypes := map[string]string{
		"it.queue.depth":      "gauge",
		"it.requests.total":   "sum",
		"it.request.duration": "histogram",
	}
	if len(types) != len(wantTypes) {
		t.Fatalf("metric_series names = %v, want %v", types, wantTypes)
	}
	for name, wantType := range wantTypes {
		if types[name] != wantType {
			t.Errorf("metric_series[%s].type = %q, want %q", name, types[name], wantType)
		}
	}
}

// TestConsumeMetricsCardinalityCapDropsNewSeriesButKeepsEstablished is D376's
// plumbing proof at the Writer boundary: Config.SeriesCap really reaches
// mapping.NewSeriesCache, a point creating a brand-new series past the cap
// is dropped and its count returned across the Consumer boundary, and an
// already-established series is never rejected regardless of the cap.
func TestConsumeMetricsCardinalityCapDropsNewSeriesButKeepsEstablished(t *testing.T) {
	conn := connect(t)
	workspaceID := newMetricsWorkspace(t, conn)
	ctx := context.Background()
	base := time.Now().UTC().Add(-time.Minute)

	w := newWriterWithCap(t, 2)

	// Two distinct new series, both under the cap of 2: no drops.
	if drops := w.ConsumeMetrics(ctx, workspaceID, gaugeMetric("it.cap.a", 1, base)); drops != 0 {
		t.Fatalf("series a: cardinalityDrops = %d, want 0", drops)
	}
	if drops := w.ConsumeMetrics(ctx, workspaceID, gaugeMetric("it.cap.b", 2, base.Add(time.Second))); drops != 0 {
		t.Fatalf("series b: cardinalityDrops = %d, want 0", drops)
	}
	// The workspace is now at cap (2/2). A further point on an ALREADY
	// established series is still admitted — established series never drop.
	if drops := w.ConsumeMetrics(ctx, workspaceID, gaugeMetric("it.cap.a", 3, base.Add(2*time.Second))); drops != 0 {
		t.Fatalf("established series a at cap: cardinalityDrops = %d, want 0", drops)
	}
	// A third, brand-new series arriving at cap is dropped and counted.
	if drops := w.ConsumeMetrics(ctx, workspaceID, gaugeMetric("it.cap.c", 4, base.Add(3*time.Second))); drops != 1 {
		t.Fatalf("new series c past cap: cardinalityDrops = %d, want 1", drops)
	}

	if err := w.Close(ctx); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	var landed uint64
	if err := conn.QueryRow(ctx,
		"SELECT count() FROM obstack.metric_points WHERE workspace_id = ?", workspaceID,
	).Scan(&landed); err != nil {
		t.Fatalf("count landed points: %v", err)
	}
	if landed != 3 {
		t.Fatalf("landed metric_points = %d, want 3 (a twice, b once; c never admitted)", landed)
	}
	var cCount uint64
	if err := conn.QueryRow(ctx,
		"SELECT count() FROM obstack.metric_points WHERE workspace_id = ? AND name = 'it.cap.c'",
		workspaceID).Scan(&cCount); err != nil {
		t.Fatalf("count series c: %v", err)
	}
	if cCount != 0 {
		t.Errorf("series c landed %d rows, want 0 — it should never have been admitted", cCount)
	}
}

// TestWriterSeedsSeriesCacheFromMetricSeriesAtBoot is D376's boot
// reconciliation proof: a second Writer — standing in for a process restart —
// seeds its cache from obstack.metric_series at New() and must treat the
// series the FIRST writer established as already-known.
//
// The discriminating move is asking the restarted writer about a BRAND-NEW
// series before it has personally seen anything: with the cap already filled
// by the seed it must reject that series, where an unseeded writer would
// happily admit it into what it thinks is an empty workspace. (Re-sending an
// established series first proves nothing — an unseeded cache admits it too,
// as a new one, and every later count lines up identically.)
func TestWriterSeedsSeriesCacheFromMetricSeriesAtBoot(t *testing.T) {
	conn := connect(t)
	workspaceID := newMetricsWorkspace(t, conn)
	ctx := context.Background()
	now := time.Now().UTC()

	first := newWriterWithCap(t, 2)
	for i, name := range []string{"it.seed.a", "it.seed.b"} {
		if drops := first.ConsumeMetrics(ctx, workspaceID, gaugeMetric(name, float64(i), now)); drops != 0 {
			t.Fatalf("first writer, %s: cardinalityDrops = %d, want 0", name, drops)
		}
	}
	if err := first.Close(ctx); err != nil {
		t.Fatalf("close first writer: %v", err)
	}

	// obstack.metric_series now carries both series with last_seen = today
	// (UTC), so a brand-new Writer with the same cap of 2 boots already full.
	second := newWriterWithCap(t, 2)
	t.Cleanup(func() { second.Close(context.Background()) })

	if drops := second.ConsumeMetrics(ctx, workspaceID, gaugeMetric("it.seed.c", 3, now.Add(time.Second))); drops != 1 {
		t.Fatalf("restarted writer, new series c: cardinalityDrops = %d, want 1 — the cap must already be full from the seed", drops)
	}
	// And the seeded series themselves are established, not re-admitted as new:
	// they still pass at a cap they exactly fill.
	if drops := second.ConsumeMetrics(ctx, workspaceID, gaugeMetric("it.seed.a", 4, now.Add(2*time.Second))); drops != 0 {
		t.Fatalf("restarted writer, seeded series a: cardinalityDrops = %d, want 0 (seeded, not new)", drops)
	}

	var cCount uint64
	if err := conn.QueryRow(ctx,
		"SELECT count() FROM obstack.metric_points WHERE workspace_id = ? AND name = 'it.seed.c'",
		workspaceID).Scan(&cCount); err != nil {
		t.Fatalf("count series c: %v", err)
	}
	if cCount != 0 {
		t.Errorf("series c landed %d rows, want 0 — the seeded cap should never have admitted it", cCount)
	}
}
