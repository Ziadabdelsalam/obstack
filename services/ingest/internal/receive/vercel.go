package receive

import (
	"bytes"
	"compress/gzip"
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // the vendor's documented signature algorithm, not ours to choose
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
)

// The Vercel log-drain receiver (D101 builds it, D254 shapes it, S5 activates
// it). It is a route on this same mux rather than a listener of its own, and it
// hands its records to the same consumeLogs the OTLP path uses — which is what
// makes metering (D99), the per-key health rows (D100), quota degradation
// (D165) and the drop counters apply to drain traffic for free, instead of
// being re-implemented beside them.
//
// The wire contract was measured from the vendor's own reference on 2026-08-23
// (vercel.com/docs/drains/reference/logs, /docs/drains/using-drains,
// /docs/drains/security), never from memory, and the fixtures beside this file
// are that reference's published payloads captured verbatim with their URL and
// retrieval date. Real wire captures replace them as an S5 activation
// done-check (D285) — until then no card claims this connector works (D101/
// D208: the hub stays "Coming soon").
//
// What the operator configures on Vercel's side: the endpoint URL, and a custom
// header `Authorization: Bearer <obstack ingest key>` — the same D98 key path
// every other export authenticates through, which is why no second credential
// concept exists here.

const (
	// vercelSignatureHeader carries an HMAC-SHA1 hex digest of the request body
	// when the drain has a signature secret set. SHA-1 is the vendor's choice,
	// documented in their verification example; it is a delivery-integrity
	// check layered on top of the bearer key, never the authentication itself.
	vercelSignatureHeader = "X-Vercel-Signature"

	// scopeVercel names the instrumentation scope the drain's records land
	// under, so a query can tell a drain-delivered line from an SDK-emitted one
	// without guessing from attributes.
	scopeVercel = "obstack.integrations.vercel"
)

// vercelLog is one entry of a drain delivery. Only the fields obstack maps are
// declared: the vendor's schema is wider, and a field this service does not use
// must not become a field it silently depends on.
type vercelLog struct {
	ID           string `json:"id"`
	DeploymentID string `json:"deploymentId"`
	Source       string `json:"source"`
	Host         string `json:"host"`
	Timestamp    int64  `json:"timestamp"`
	ProjectID    string `json:"projectId"`
	ProjectName  string `json:"projectName"`
	Level        string `json:"level"`
	Message      string `json:"message"`
	Path         string `json:"path"`
	StatusCode   *int   `json:"statusCode"`
	RequestID    string `json:"requestId"`
	Environment  string `json:"environment"`
	Branch       string `json:"branch"`
	Region       string `json:"executionRegion"`
	Type         string `json:"type"`
	Entrypoint   string `json:"entrypoint"`

	// Trace context, when Vercel Tracing is on. These are MEASURED fields that
	// actually carry it (D254): they are read, and nothing else is inferred
	// into trace context. The dotted forms are the same values under the
	// vendor's alternative spelling and are read only as a fallback.
	TraceID    string `json:"traceId"`
	SpanID     string `json:"spanId"`
	TraceIDDot string `json:"trace.id"`
	SpanIDDot  string `json:"span.id"`
}

// vercelHandler serves one drain delivery.
//
// It deliberately does not go through export(): that path negotiates OTLP's
// protobuf/JSON encodings and answers with OTLP Status messages, none of which
// this endpoint speaks (D291). What it shares is the part that matters — the
// same bearer resolution, and the same consume path.
func (s *Server) vercelHandler(w http.ResponseWriter, r *http.Request) {
	identity, err := s.cfg.Auth.Workspace(r.Header.Get("Authorization"))
	if err != nil {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeJSONError(w, http.StatusUnauthorized, "missing or unknown API key")
		return
	}
	if slot, ok := r.Context().Value(workspaceKey{}).(*string); ok {
		*slot = identity.WorkspaceID
	}

	// The body is read RAW and capped before anything decompresses it: the
	// signature is computed over the bytes as received (D287), so gunzipping
	// first would verify a digest of something the sender never signed.
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

	if secret := s.cfg.VercelDrainSecret; secret != "" {
		if !validVercelSignature(raw, r.Header.Get(vercelSignatureHeader), secret) {
			// Counted like any other post-auth refusal (D26): this is telemetry
			// from a known workspace that we would not take.
			s.countDrop(identity, dropUnsupported, 1)
			writeJSONError(w, http.StatusUnauthorized, "signature did not match")
			return
		}
	}

	body, err := decompressBody(raw, r.Header.Get("Content-Encoding"))
	if err != nil {
		s.countDrop(identity, dropDecode, 1)
		writeJSONError(w, http.StatusBadRequest, "unreadable request body")
		return
	}

	entries, err := decodeVercelLogs(body)
	if err != nil {
		// One 4xx ends it (D6): a payload we cannot read will not become
		// readable on a retry of the same bytes.
		s.countDrop(identity, dropDecode, 1)
		writeJSONError(w, http.StatusBadRequest, "malformed drain payload")
		return
	}

	ld, skipped := vercelLogsToPdata(entries)
	if skipped > 0 {
		// An entry with no usable timestamp cannot be a row; it is a drop like
		// any other rather than a silent omission.
		s.countDrop(identity, dropDecode, skipped)
	}
	if ld.LogRecordCount() > 0 {
		s.consumeLogs(auth.ContextWithIdentity(r.Context(), identity),
			identity.WorkspaceID, plogotlp.NewExportRequestFromLogs(ld))
	}

	// 200 fast, and never a status that depends on ClickHouse: a drain whose
	// deliveries fail is disabled by Vercel after ~80% failures, and enqueue is
	// what this endpoint acknowledges (D23) exactly as the OTLP path does.
	writeJSONOK(w)
}

// decompressBody undoes the gzip a sender may have applied, after the raw bytes
// have been capped and (for the drain) signature-checked. The decompressed
// stream is capped again for the reason readBody caps its own: a few hundred
// compressed KiB must not be allowed to expand into gigabytes of heap.
func decompressBody(raw []byte, contentEncoding string) ([]byte, error) {
	if !strings.EqualFold(strings.TrimSpace(contentEncoding), "gzip") {
		return raw, nil
	}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	body, err := io.ReadAll(io.LimitReader(gz, maxRequestBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxRequestBytes {
		return nil, errors.New("decompressed payload is over the 16MiB limit")
	}
	return body, nil
}

// validVercelSignature is the vendor's documented check, in constant time:
// HMAC-SHA1 of the raw body under the drain secret, hex-encoded.
func validVercelSignature(body []byte, header, secret string) bool {
	if header == "" {
		return false
	}
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(header))
}

// decodeVercelLogs takes both encodings the drain can be configured with, and
// both spellings the vendor's own documentation gives for one of them: its
// prose calls the JSON format "JSON arrays containing log objects" while the
// example published under that heading is an unbracketed sequence of objects.
// Rather than pick a side of that contradiction, the decoder reads a bracketed
// array when it sees one and otherwise streams objects — which also covers
// NDJSON, since a newline between objects is whitespace to a JSON stream
// decoder. Whichever shape the wire actually carries, this route takes it.
func decodeVercelLogs(body []byte) ([]vercelLog, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, nil
	}

	if trimmed[0] == '[' {
		var entries []vercelLog
		if err := json.Unmarshal(trimmed, &entries); err != nil {
			return nil, err
		}
		return entries, nil
	}

	var entries []vercelLog
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	for {
		var entry vercelLog
		if err := dec.Decode(&entry); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// vercelLogsToPdata maps entries to log records, reporting how many were
// unmappable. One resource for the batch would be wrong — a delivery can span
// deployments — so records group by the resource identity the entry carries.
func vercelLogsToPdata(entries []vercelLog) (plog.Logs, int) {
	ld := plog.NewLogs()
	skipped := 0

	// The resource identity is built from fields that identify a deployment,
	// never from the optional display name (D295): keying on `projectName`
	// would put two entries of the same deployment under two resources purely
	// because one of them omitted a label.
	type resourceKey struct{ project, deployment, environment string }
	scopes := map[resourceKey]plog.LogRecordSlice{}

	for _, entry := range entries {
		if entry.Timestamp <= 0 {
			// Without a time the row would partition into 1970 and never be
			// found — the same refusal internal/mapping makes for OTLP records
			// with no timestamp.
			skipped++
			continue
		}

		key := resourceKey{entry.ProjectID, entry.DeploymentID, entry.Environment}
		records, ok := scopes[key]
		if !ok {
			rl := ld.ResourceLogs().AppendEmpty()
			res := rl.Resource().Attributes()
			// service.name is what every obstack surface groups by, so it is
			// computed from a field that is on EVERY entry of a project: the
			// project id (D295). `projectName` is per-entry optional — absent
			// on the vendor's own lambda example, which is the main runtime
			// source — so grouping by it would split one project into two
			// services, one of them named and one of them not. The human name
			// rides along as an attribute for a surface to render; identity
			// does not depend on it. Stable and opaque beats friendly and
			// split.
			res.PutStr("service.name", firstNonEmpty(entry.ProjectID, "vercel"))
			putIfSet(res, "vercel.project.id", entry.ProjectID)
			putIfSet(res, "vercel.project.name", entry.ProjectName)
			putIfSet(res, "vercel.deployment.id", entry.DeploymentID)
			putIfSet(res, "deployment.environment", entry.Environment)

			sl := rl.ScopeLogs().AppendEmpty()
			sl.Scope().SetName(scopeVercel)
			records = sl.LogRecords()
			scopes[key] = records
		}

		record := records.AppendEmpty()
		// The vendor's timestamps are unix milliseconds.
		ts := time.UnixMilli(entry.Timestamp).UTC()
		record.SetTimestamp(pcommon.NewTimestampFromTime(ts))
		record.SetObservedTimestamp(pcommon.NewTimestampFromTime(ts))

		severityText, severityNumber := vercelSeverity(entry.Level)
		record.SetSeverityText(severityText)
		record.SetSeverityNumber(severityNumber)
		record.Body().SetStr(entry.Message)

		attrs := record.Attributes()
		putIfSet(attrs, "vercel.log.id", entry.ID)
		putIfSet(attrs, "vercel.source", entry.Source)
		putIfSet(attrs, "vercel.type", entry.Type)
		putIfSet(attrs, "vercel.entrypoint", entry.Entrypoint)
		putIfSet(attrs, "vercel.branch", entry.Branch)
		putIfSet(attrs, "vercel.region", entry.Region)
		putIfSet(attrs, "http.request.id", entry.RequestID)
		putIfSet(attrs, "url.path", entry.Path)
		putIfSet(attrs, "server.address", entry.Host)
		if entry.StatusCode != nil {
			attrs.PutStr("http.response.status_code", strconv.Itoa(*entry.StatusCode))
		}

		// Trace context only from the measured fields (D254). Anything that
		// does not parse as a real id is left empty: a log that joins nothing
		// is honest, a log joined to an invented trace is not.
		setTraceContext(record,
			firstNonEmpty(entry.TraceID, entry.TraceIDDot),
			firstNonEmpty(entry.SpanID, entry.SpanIDDot))
	}

	return ld, skipped
}

// vercelSeverity maps the vendor's four levels onto the OTel severity numbers.
// An unknown level keeps its text and takes UNSPECIFIED rather than being
// coerced into a level the sender never claimed.
func vercelSeverity(level string) (string, plog.SeverityNumber) {
	switch strings.ToLower(level) {
	case "info":
		return "INFO", plog.SeverityNumberInfo
	case "warning":
		return "WARN", plog.SeverityNumberWarn
	case "error":
		return "ERROR", plog.SeverityNumberError
	case "fatal":
		return "FATAL", plog.SeverityNumberFatal
	default:
		return level, plog.SeverityNumberUnspecified
	}
}

// setTraceContext fills the record's ids from hex strings, silently leaving
// them empty when they are not the ids they claim to be.
func setTraceContext(record plog.LogRecord, traceID, spanID string) {
	if raw, err := hex.DecodeString(traceID); err == nil && len(raw) == 16 {
		var id pcommon.TraceID
		copy(id[:], raw)
		record.SetTraceID(id)
	}
	if raw, err := hex.DecodeString(spanID); err == nil && len(raw) == 8 {
		var id pcommon.SpanID
		copy(id[:], raw)
		record.SetSpanID(id)
	}
}

func putIfSet(m pcommon.Map, key, value string) {
	if value != "" {
		m.PutStr(key, value)
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// writeJSONOK and writeJSONError are the integration routes' answers. They are
// deliberately not writeSuccess/writeError: those speak google.rpc.Status in
// OTLP's encodings, which no drain sender reads.
func writeJSONOK(w http.ResponseWriter) {
	w.Header().Set("Content-Type", contentTypeJSON)
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"ok":true}`))
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", contentTypeJSON)
	w.WriteHeader(status)
	body, err := json.Marshal(map[string]string{"error": message})
	if err != nil {
		body = nil
	}
	w.Write(body)
}
