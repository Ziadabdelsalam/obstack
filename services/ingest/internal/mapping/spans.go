package mapping

import (
	"fmt"
	"strings"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pricing"
)

// SpanRows maps a decoded trace payload to obstack.spans rows. A span that
// cannot be mapped is dropped and counted (D6) — the rest of the payload still
// lands, because one malformed span in a batch of ten thousand is not a reason
// to lose the other 9,999.
//
// prices is the workspace's table — the embedded list with its D108 overrides
// layered on — resolved by the caller once per export, not per span. It is
// required: the writer resolves it (nil there means the embedded list), so a
// span priced by the wrong workspace's table is not a shape this can reach.
func SpanRows(workspaceID string, td ptrace.Traces, prices *pricing.Table) []SpanRow {
	rows := make([]SpanRow, 0, td.SpanCount())
	for _, rs := range td.ResourceSpans().All() {
		res := mapResource(rs.Resource().Attributes())
		for _, ss := range rs.ScopeSpans().All() {
			for _, span := range ss.Spans().All() {
				row, err := mapSpan(workspaceID, res, span, prices)
				if err != nil {
					metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonMapping).Inc()
					continue
				}
				rows = append(rows, row)
			}
		}
	}
	return rows
}

func mapSpan(workspaceID string, res resource, span ptrace.Span, prices *pricing.Table) (SpanRow, error) {
	// IDs are the primary key and the join key for logs; a span missing either
	// is unreachable from every surface in the product.
	if span.TraceID().IsEmpty() {
		return SpanRow{}, fmt.Errorf("span %q has no trace id", span.Name())
	}
	if span.SpanID().IsEmpty() {
		return SpanRow{}, fmt.Errorf("span %q has no span id", span.Name())
	}
	// The table partitions on start_time and expires by it, so a span with no
	// start would land in 1970 and sit outside every query window.
	if span.StartTimestamp() == 0 {
		return SpanRow{}, fmt.Errorf("span %q has no start timestamp", span.Name())
	}

	attrs := span.Attributes()
	layer := classify(attrs)

	row := SpanRow{
		WorkspaceID:   workspaceID,
		TraceID:       span.TraceID().String(),
		SpanID:        span.SpanID().String(),
		ParentSpanID:  span.ParentSpanID().String(),
		Name:          span.Name(),
		Kind:          kindOf(span.Kind()),
		Service:       res.service,
		StartTime:     span.StartTimestamp().AsTime(),
		DurationNS:    durationNS(span),
		StatusCode:    statusOf(span.Status().Code()),
		StatusMessage: span.Status().Message(),

		Layer: layer,

		K8sNamespace: res.k8sNamespace,
		K8sPod:       res.k8sPod,
		K8sContainer: res.k8sContainer,
		K8sNode:      res.k8sNode,

		Attributes:         flattenAttributes(attrs, attrGenAIPrompt, attrGenAICompletion),
		ResourceAttributes: res.attributes,
	}

	// GenAI columns are only meaningful on LLM spans, and pricing is only
	// attempted there: a non-LLM span carrying a stray model attribute must not
	// show up as a gap in the price table.
	if layer == LayerLLM {
		row.GenAISystem = attrStr(attrs, attrGenAISystem)
		row.GenAIRequestModel = attrStr(attrs, attrGenAIRequestModel)
		row.GenAIResponseModel = attrStr(attrs, attrGenAIResponseModel)
		row.InputTokens = attrUint32(attrs, attrGenAIInputTokens)
		row.OutputTokens = attrUint32(attrs, attrGenAIOutputTokens)
		row.FinishReason = finishReason(attrs)
		row.Prompt = attrStr(attrs, attrGenAIPrompt)
		row.Completion = attrStr(attrs, attrGenAICompletion)
		row.CostUSD = prices.Cost(
			row.GenAIRequestModel, row.GenAIResponseModel,
			int64(row.InputTokens), int64(row.OutputTokens),
		)
	}

	return row, nil
}

// classify implements the D8 layer rules. Order is the contract: an LLM call
// made from inside an agent step carries both markers, and it is the LLM view
// that has to find it.
func classify(attrs pcommon.Map) string {
	for k := range attrs.All() {
		if strings.HasPrefix(k, genAIPrefix) {
			return LayerLLM
		}
	}
	if _, ok := attrs.Get(attrAgentStep); ok {
		return LayerAgent
	}
	if _, ok := attrs.Get(attrToolName); ok {
		return LayerTool
	}
	if _, ok := attrs.Get(attrHTTPMethod); ok {
		return LayerAPI
	}
	if _, ok := attrs.Get(attrHTTPRoute); ok {
		return LayerAPI
	}
	return LayerOther
}

// finishReason reads the single finish reason the column holds. Semconv turned
// the attribute into an array (a response may hold several choices); the row has
// one value, so the first choice wins — it is the one every UI shows.
func finishReason(attrs pcommon.Map) string {
	if v, ok := attrs.Get(attrGenAIFinishReason); ok {
		return v.AsString()
	}
	v, ok := attrs.Get(attrGenAIFinishReasons)
	if !ok {
		return ""
	}
	if v.Type() == pcommon.ValueTypeSlice {
		if s := v.Slice(); s.Len() > 0 {
			return s.At(0).AsString()
		}
		return ""
	}
	return v.AsString()
}

// durationNS is end - start. An end before the start is a broken clock on the
// client, not something to reject the span over: zero duration still renders.
func durationNS(span ptrace.Span) uint64 {
	end, start := span.EndTimestamp(), span.StartTimestamp()
	if end <= start {
		return 0
	}
	return uint64(end - start)
}

func kindOf(kind ptrace.SpanKind) string {
	switch kind {
	case ptrace.SpanKindInternal:
		return "internal"
	case ptrace.SpanKindServer:
		return "server"
	case ptrace.SpanKindClient:
		return "client"
	case ptrace.SpanKindProducer:
		return "producer"
	case ptrace.SpanKindConsumer:
		return "consumer"
	default:
		return "unspecified"
	}
}

func statusOf(code ptrace.StatusCode) string {
	switch code {
	case ptrace.StatusCodeOk:
		return "ok"
	case ptrace.StatusCodeError:
		return "error"
	default:
		return "unset"
	}
}
