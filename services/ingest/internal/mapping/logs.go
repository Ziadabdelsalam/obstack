package mapping

import (
	"fmt"

	"go.opentelemetry.io/collector/pdata/plog"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
)

// LogRows maps a decoded log payload to obstack.logs rows. Trace context is kept
// as-is: a record without it gets empty ids, which is a first-class case (not
// every log line happens inside a span) and sorts to the head of the ordering
// key rather than polluting a trace's range read.
func LogRows(workspaceID string, ld plog.Logs) []LogRow {
	rows := make([]LogRow, 0, ld.LogRecordCount())
	for _, rl := range ld.ResourceLogs().All() {
		res := mapResource(rl.Resource().Attributes())
		for _, sl := range rl.ScopeLogs().All() {
			for _, record := range sl.LogRecords().All() {
				row, err := mapLogRecord(workspaceID, res, record)
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

func mapLogRecord(workspaceID string, res resource, record plog.LogRecord) (LogRow, error) {
	// Emitters that cannot read the wall clock (browser exporters, some log
	// bridges) leave Timestamp unset and only fill ObservedTimestamp — the time
	// the pipeline saw the record, which is the better answer than no time at
	// all. With neither, the row would partition into 1970 and never be found.
	ts := record.Timestamp()
	if ts == 0 {
		ts = record.ObservedTimestamp()
	}
	if ts == 0 {
		return LogRow{}, fmt.Errorf("log record has no timestamp")
	}

	// The column is a UInt8 and the spec's range is 0..24; anything outside it
	// is a broken emitter, and clamping keeps the row rather than losing the
	// message it carries.
	severity := record.SeverityNumber()
	if severity < 0 {
		severity = 0
	}
	if severity > 255 {
		severity = 255
	}

	attrs := record.Attributes()

	return LogRow{
		WorkspaceID:    workspaceID,
		Timestamp:      ts.AsTime(),
		TraceID:        record.TraceID().String(),
		SpanID:         record.SpanID().String(),
		SeverityNumber: uint8(severity),
		SeverityText:   record.SeverityText(),
		Body:           record.Body().AsString(),
		Service:        res.service,

		// Log-record GenAI content (D38 FINAL / D42): attrStr returns "" when
		// the attribute is absent, which is the honest fill for a log record
		// that carries neither — this is not gated on any layer classification,
		// unlike the span-attribute form.
		Prompt:     attrStr(attrs, attrGenAIInputMessages),
		Completion: attrStr(attrs, attrGenAIOutputMessages),

		K8sNamespace: res.k8sNamespace,
		K8sPod:       res.k8sPod,
		K8sContainer: res.k8sContainer,

		// The two content keys are excluded here unconditionally, same as the
		// span form (D8 amendment extended to logs): a second copy in the
		// uncompressed Map would be pure waste whether or not this record
		// actually carried them.
		Attributes:         flattenAttributes(attrs, attrGenAIInputMessages, attrGenAIOutputMessages),
		ResourceAttributes: res.attributes,
	}, nil
}
