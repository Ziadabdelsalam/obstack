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
