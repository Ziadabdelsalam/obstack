package receive

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
)

// The CloudWatch Logs receiver (D101 builds it, D254 shapes it, S5 activates
// it). AWS delivers subscription-filter data to a destination in its own
// envelope — base64 of gzip of JSON, wrapped in `{"awslogs":{"data":…}}` — so
// the artifact in someone else's AWS account is a small forwarder that decodes
// that envelope and POSTs the JSON here (deploy/cloudwatch-forwarder). This
// route takes the DECODED form: the decode is trivial and belongs where the
// bytes already are, while the mapping belongs in Go where the tests are.
//
// The envelope was measured from the vendor's reference on 2026-08-23
// (docs.aws.amazon.com/AmazonCloudWatch/latest/logs/SubscriptionFilters.html,
// "Example 2: Subscription filters with AWS Lambda"), and the fixture beside
// this file is that page's published payload captured verbatim (D285).
//
// Correlation posture, stated because its absence is the fact (D254): the
// CloudWatch envelope carries NO trace context — not in the envelope, not in a
// log event. Records land trace-less and join as the nearby class (D37's
// window). Nothing is parsed out of message text to invent one.

// scopeCloudWatch names the instrumentation scope these records land under.
const scopeCloudWatch = "obstack.integrations.cloudwatch"

// cloudWatchPayload is the decoded subscription-filter envelope.
type cloudWatchPayload struct {
	Owner               string            `json:"owner"`
	LogGroup            string            `json:"logGroup"`
	LogStream           string            `json:"logStream"`
	SubscriptionFilters []string          `json:"subscriptionFilters"`
	MessageType         string            `json:"messageType"`
	LogEvents           []cloudWatchEvent `json:"logEvents"`
}

type cloudWatchEvent struct {
	ID        string `json:"id"`
	Timestamp int64  `json:"timestamp"`
	Message   string `json:"message"`
}

// messageTypeControl is AWS's reachability probe: a delivery carrying no log
// events, sent to check the destination answers. It is acknowledged and
// otherwise ignored — counting it as telemetry would put an event on a
// workspace's usage that nobody sent.
const messageTypeControl = "CONTROL_MESSAGE"

// cloudWatchHandler serves one forwarded delivery. Like the drain route it does
// not go through export() (D291) — it shares the bearer resolution and the
// consume path, which is what makes metering, health rows, quota and drop
// counting apply to it for free.
func (s *Server) cloudWatchHandler(w http.ResponseWriter, r *http.Request) {
	identity, err := s.cfg.Auth.Workspace(r.Header.Get("Authorization"))
	if err != nil {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeJSONError(w, http.StatusUnauthorized, "missing or unknown API key")
		return
	}
	if slot, ok := r.Context().Value(workspaceKey{}).(*string); ok {
		*slot = identity.WorkspaceID
	}

	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		s.countDrop(identity, dropDecode, 1)
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "payload is over the 16MiB limit")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "unreadable request body")
		return
	}

	body, err := decompressBody(raw, r.Header.Get("Content-Encoding"))
	if err != nil {
		s.countDrop(identity, dropDecode, 1)
		writeJSONError(w, http.StatusBadRequest, "unreadable request body")
		return
	}

	var payload cloudWatchPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		s.countDrop(identity, dropDecode, 1)
		writeJSONError(w, http.StatusBadRequest, "malformed cloudwatch payload")
		return
	}

	if strings.EqualFold(payload.MessageType, messageTypeControl) {
		// Reachability probe: answered, never metered.
		writeJSONOK(w)
		return
	}

	ld, skipped := cloudWatchToPdata(payload)
	if skipped > 0 {
		s.countDrop(identity, dropDecode, skipped)
	}
	if ld.LogRecordCount() > 0 {
		s.consumeLogs(auth.ContextWithIdentity(r.Context(), identity),
			identity.WorkspaceID, plogotlp.NewExportRequestFromLogs(ld))
	}
	writeJSONOK(w)
}

// cloudWatchToPdata maps one delivery to log records: one resource for the
// delivery, because a subscription-filter delivery is by construction one log
// group and one stream.
func cloudWatchToPdata(payload cloudWatchPayload) (plog.Logs, int) {
	ld := plog.NewLogs()
	skipped := 0

	usable := 0
	for _, e := range payload.LogEvents {
		if e.Timestamp > 0 {
			usable++
		}
	}
	if usable == 0 {
		return ld, len(payload.LogEvents)
	}

	rl := ld.ResourceLogs().AppendEmpty()
	res := rl.Resource().Attributes()
	// The log group is the closest thing AWS gives to a service identity; the
	// leading path segments of the conventional /aws/lambda/<name> shape are
	// dropped so the name reads as the service it is.
	res.PutStr("service.name", cloudWatchService(payload.LogGroup))
	putIfSet(res, "aws.log.group.names", payload.LogGroup)
	putIfSet(res, "aws.log.stream.names", payload.LogStream)
	putIfSet(res, "cloud.account.id", payload.Owner)
	res.PutStr("cloud.provider", "aws")

	sl := rl.ScopeLogs().AppendEmpty()
	sl.Scope().SetName(scopeCloudWatch)
	records := sl.LogRecords()

	for _, e := range payload.LogEvents {
		if e.Timestamp <= 0 {
			skipped++
			continue
		}
		record := records.AppendEmpty()
		ts := time.UnixMilli(e.Timestamp).UTC()
		record.SetTimestamp(pcommon.NewTimestampFromTime(ts))
		record.SetObservedTimestamp(pcommon.NewTimestampFromTime(ts))
		// CloudWatch carries no level of its own — the message is whatever the
		// emitter wrote. Claiming a severity here would be inventing one.
		record.SetSeverityNumber(plog.SeverityNumberUnspecified)
		record.Body().SetStr(e.Message)
		putIfSet(record.Attributes(), "aws.cloudwatch.event.id", e.ID)
		// No trace context is set: the envelope carries none (D254).
	}

	return ld, skipped
}

// cloudWatchService turns a log group into a service name: /aws/lambda/checkout
// reads as "checkout", anything else keeps its own name.
func cloudWatchService(logGroup string) string {
	if logGroup == "" {
		return "cloudwatch"
	}
	parts := strings.Split(strings.Trim(logGroup, "/"), "/")
	return parts[len(parts)-1]
}
