// Package mapping turns decoded OTLP payloads into the ClickHouse rows of D7.
// It is the service's interop surface: everything the product can show about a
// span is decided here, from foreign OTel SDKs as much as from obstack's own, so
// the attribute names below are a contract rather than an implementation detail.
//
// # GenAI extraction contract (D8)
//
// LLM spans are recognised and unpacked from these span attributes:
//
//	gen_ai.system                 -> gen_ai_system
//	gen_ai.request.model          -> gen_ai_request_model
//	gen_ai.response.model         -> gen_ai_response_model
//	gen_ai.usage.input_tokens     -> input_tokens
//	gen_ai.usage.output_tokens    -> output_tokens
//	gen_ai.prompt                 -> prompt
//	gen_ai.completion             -> completion
//	gen_ai.response.finish_reason -> finish_reason  (or …finish_reasons[0])
//
// prompt and completion live only in those dedicated ZSTD columns: they are
// deliberately left out of the attributes Map, so readers — the web adapter
// today, the M2 SDK docs tomorrow — take them from the columns and never from
// attributes['gen_ai.prompt'] (D8 amendment).
//
// cost_usd is computed here, at ingest, from the embedded price list (D9).
//
// # GenAI log-record extraction (D38 FINAL / D42, carry-forward 3)
//
// A log record is the second, independent wire form GenAI content arrives in:
// upstream's Events API, as opposed to the obstack-SDK's span-attribute form
// above. Unlike spans, log records get no layer gate — any log record carrying
// either attribute below is unpacked, unconditionally, into obstack.logs'
// prompt/completion columns (span_id already identifies which span it belongs
// to; that column has existed since M1):
//
//	gen_ai.input.messages  -> prompt
//	gen_ai.output.messages -> completion
//
// The fill is pcommon's AsString, which is one of two cases depending on what
// the producer sent: a plain string value is stored verbatim; a structured
// value (semconv types the attribute `any`, and upstream's Events API sends
// one) has no producer JSON bytes to preserve — a protobuf AnyValue, not text
// — so AsString renders it through pcommon's canonical JSON serialization
// (deterministic, alphabetically-sorted keys), test-pinned in the fixtures
// below rather than merely described. Either way nothing is re-encoded or
// truncated after that. As above, both keys are excluded from the row's
// attributes Map regardless of whether either was present (D8 amendment
// extended to logs): a reader takes prompt/completion from the dedicated
// columns, never from attributes['gen_ai.input.messages'].
//
// Span-EVENT extraction (gen_ai.* attributes on a span's own Events()) is NOT
// implemented: no known producer emits that wire form, and D38 FINAL rules it
// speculative until one does.
//
// # Precedence when both forms describe one span (D42(d); read-time, T6's to implement)
//
// Per field (prompt, completion) independently: a non-empty span column always
// wins; only when it is empty does an event-derived (log-record) value fill it.
// When more than one log row matches (workspace_id, trace_id, span_id), the
// field is taken from the earliest-timestamp row whose *that* field is
// non-empty — resolved per field, so a prompt-only row and a later
// completion-only row each fill their own. Deterministic, because the read is
// already timestamp-ordered. At equal timestamps, ties resolve by the total
// order (timestamp, span_id, prompt, completion) — deterministic across parts
// and merges. Content never enters cost or token computation, which
// stays span-attribute-sourced (D9): no double-count by construction. T2 lands
// the rows below; T6 implements the read that applies this precedence.
//
// Fixtures in mapping_test.go and write/integration_test.go encode the
// gen_ai.input.messages / gen_ai.output.messages message-array shape from OTel
// semantic conventions gen-ai-events, rev v1.37.0 (2025-09) —
// https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/.
//
// # Layer classification (D8)
//
// Every row carries a layer, decided in this order — first match wins:
//
//	any gen_ai.* attribute  -> llm
//	obstack.agent.step      -> agent
//	obstack.tool.name       -> tool
//	http.request.method or http.route -> api
//	otherwise               -> other
//
// 'infra' is reserved for the M2 collector spans and is never assigned here.
// The layer is always set explicitly, on every row (D22): the column's zero
// value is 'other', so an unset layer would be indistinguishable from a span
// that genuinely matched nothing.
package mapping

import (
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
)

// Layer values, matching the Enum8 in 0001_spans.sql.
const (
	LayerOther = "other"
	LayerAPI   = "api"
	LayerAgent = "agent"
	LayerTool  = "tool"
	LayerLLM   = "llm"
)

// The attributes the classifier and the extractor read. Named constants because
// each one is a promise to instrumentation authors, not a local string.
const (
	genAIPrefix = "gen_ai."

	attrGenAISystem        = "gen_ai.system"
	attrGenAIRequestModel  = "gen_ai.request.model"
	attrGenAIResponseModel = "gen_ai.response.model"
	attrGenAIInputTokens   = "gen_ai.usage.input_tokens"
	attrGenAIOutputTokens  = "gen_ai.usage.output_tokens"
	attrGenAIPrompt        = "gen_ai.prompt"
	attrGenAICompletion    = "gen_ai.completion"
	attrGenAIFinishReason  = "gen_ai.response.finish_reason"
	attrGenAIFinishReasons = "gen_ai.response.finish_reasons"

	attrAgentStep  = "obstack.agent.step"
	attrToolName   = "obstack.tool.name"
	attrHTTPMethod = "http.request.method"
	attrHTTPRoute  = "http.route"
)

// The log-record GenAI content attributes (D38 FINAL / D42) — see the package
// doc's "GenAI log-record extraction" section for the contract.
const (
	attrGenAIInputMessages  = "gen_ai.input.messages"
	attrGenAIOutputMessages = "gen_ai.output.messages"
)

// Resource attributes promoted to their own columns (D7).
const (
	attrServiceName  = "service.name"
	attrK8sNamespace = "k8s.namespace.name"
	attrK8sPod       = "k8s.pod.name"
	attrK8sContainer = "k8s.container.name"
	attrK8sNode      = "k8s.node.name"
)

// SpanRow is one row of obstack.spans. Field order is the writer's business;
// this struct is addressed by name.
type SpanRow struct {
	WorkspaceID   string
	TraceID       string
	SpanID        string
	ParentSpanID  string
	Name          string
	Kind          string
	Service       string
	StartTime     time.Time
	DurationNS    uint64
	StatusCode    string
	StatusMessage string

	Layer string

	GenAISystem        string
	GenAIRequestModel  string
	GenAIResponseModel string
	InputTokens        uint32
	OutputTokens       uint32
	CostUSD            float64
	FinishReason       string
	Prompt             string
	Completion         string

	K8sNamespace string
	K8sPod       string
	K8sContainer string
	K8sNode      string

	Attributes         map[string]string
	ResourceAttributes map[string]string
}

// LogRow is one row of obstack.logs.
type LogRow struct {
	WorkspaceID    string
	Timestamp      time.Time
	TraceID        string
	SpanID         string
	SeverityNumber uint8
	SeverityText   string
	Body           string
	Service        string

	// Prompt and Completion carry the log-record GenAI wire form (D38 FINAL /
	// D42): empty unless the record carried gen_ai.input.messages /
	// gen_ai.output.messages. Unlike SpanRow's Prompt/Completion, filling these
	// is unconditional — logs get no layer gate.
	Prompt     string
	Completion string

	K8sNamespace string
	K8sPod       string
	K8sContainer string

	Attributes         map[string]string
	ResourceAttributes map[string]string
}

// resource holds the columns lifted out of a ResourceSpans/ResourceLogs, mapped
// once per resource rather than once per record.
type resource struct {
	service      string
	k8sNamespace string
	k8sPod       string
	k8sContainer string
	k8sNode      string
	attributes   map[string]string
}

func mapResource(attrs pcommon.Map) resource {
	return resource{
		service:      attrStr(attrs, attrServiceName),
		k8sNamespace: attrStr(attrs, attrK8sNamespace),
		k8sPod:       attrStr(attrs, attrK8sPod),
		k8sContainer: attrStr(attrs, attrK8sContainer),
		k8sNode:      attrStr(attrs, attrK8sNode),
		attributes:   flattenAttributes(attrs),
	}
}

// flattenAttributes renders an attribute map as the Map(String, String) column.
// Nested maps and slices become JSON, which is what pcommon's own AsString does
// and what every OTLP JSON exporter would have sent anyway. Keys in skip are
// left out — the writer stores them in dedicated columns and a second copy in an
// uncompressed Map would be pure waste.
func flattenAttributes(attrs pcommon.Map, skip ...string) map[string]string {
	out := make(map[string]string, attrs.Len())
	for k, v := range attrs.All() {
		if slices.Contains(skip, k) {
			continue
		}
		out[k] = v.AsString()
	}
	return out
}

func attrStr(attrs pcommon.Map, key string) string {
	v, ok := attrs.Get(key)
	if !ok {
		return ""
	}
	return v.AsString()
}

// attrUint32 reads a token count. SDKs disagree on the wire type — the OTel spec
// says int, but JSON exporters and a few instrumentations send a double or a
// string — and a token count that arrives as "1024" is still a token count.
func attrUint32(attrs pcommon.Map, key string) uint32 {
	v, ok := attrs.Get(key)
	if !ok {
		return 0
	}
	var n int64
	switch v.Type() {
	case pcommon.ValueTypeInt:
		n = v.Int()
	case pcommon.ValueTypeDouble:
		n = int64(v.Double())
	case pcommon.ValueTypeStr:
		n, _ = strconv.ParseInt(strings.TrimSpace(v.Str()), 10, 64)
	}
	if n < 0 {
		return 0
	}
	if n > math.MaxUint32 {
		return math.MaxUint32
	}
	return uint32(n)
}
