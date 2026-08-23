package receive_test

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metering"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/receive"
)

const (
	contentTypeProto = "application/x-protobuf"
	contentTypeJSON  = "application/json"
)

type httpRequest struct {
	path        string
	contentType string
	body        []byte
	bearer      string
	gzipped     bool

	// preCompressed sends body as-is under Content-Encoding: gzip — the caller
	// compressed it themselves, which the drain's signature proofs need in
	// order to sign the exact bytes the server will read (D287).
	preCompressed bool

	// headers are extra request headers, e.g. the drain signature.
	headers map[string]string
}

// gzipBytes is the compression the harness applies, exposed so a test can
// compress a payload itself and still send exactly those bytes.
func gzipBytes(t *testing.T, body []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(body); err != nil {
		t.Fatalf("gzip payload: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip payload: %v", err)
	}
	return buf.Bytes()
}

func post(t *testing.T, srv *receive.Server, req httpRequest) *http.Response {
	t.Helper()

	body := req.body
	if req.gzipped {
		body = gzipBytes(t, body)
	}

	httpReq, err := http.NewRequest(http.MethodPost, "http://"+srv.HTTPAddr()+req.path, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if req.contentType != "" {
		httpReq.Header.Set("Content-Type", req.contentType)
	}
	if req.bearer != "" {
		httpReq.Header.Set("Authorization", req.bearer)
	}
	if req.gzipped || req.preCompressed {
		httpReq.Header.Set("Content-Encoding", "gzip")
	}
	for key, value := range req.headers {
		if value != "" {
			httpReq.Header.Set(key, value)
		}
	}

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		t.Fatalf("POST %s: %v", req.path, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func mustMarshal(t *testing.T, marshal func() ([]byte, error)) []byte {
	t.Helper()
	body, err := marshal()
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	return body
}

func TestHTTPAcceptsValidExport(t *testing.T) {
	traceReq := ptraceotlp.NewExportRequestFromTraces(traceFixture())
	logReq := plogotlp.NewExportRequestFromLogs(logFixture())

	cases := []struct {
		name        string
		path        string
		contentType string
		body        []byte
		gzipped     bool
		wantTraces  int
		wantLogs    int
	}{
		{"traces protobuf", "/v1/traces", contentTypeProto, mustMarshal(t, traceReq.MarshalProto), false, 1, 0},
		{"traces json", "/v1/traces", contentTypeJSON, mustMarshal(t, traceReq.MarshalJSON), false, 1, 0},
		{"traces protobuf gzipped", "/v1/traces", contentTypeProto, mustMarshal(t, traceReq.MarshalProto), true, 1, 0},
		{"traces protobuf with charset", "/v1/traces", contentTypeProto + "; charset=utf-8", mustMarshal(t, traceReq.MarshalProto), false, 1, 0},
		{"logs protobuf", "/v1/logs", contentTypeProto, mustMarshal(t, logReq.MarshalProto), false, 0, 1},
		{"logs json", "/v1/logs", contentTypeJSON, mustMarshal(t, logReq.MarshalJSON), false, 0, 1},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, rec := startServer(t)

			resp := post(t, srv, httpRequest{
				path:        tc.path,
				contentType: tc.contentType,
				body:        tc.body,
				bearer:      "Bearer " + testKey,
				gzipped:     tc.gzipped,
			})
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200", resp.StatusCode)
			}

			// The body must be a well-formed export response in the same
			// encoding, or exporters treat the success as a protocol error.
			raw, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatalf("read response: %v", err)
			}
			assertExportResponse(t, tc.path, tc.contentType, raw)

			traces, logs := rec.counts()
			if traces != tc.wantTraces || logs != tc.wantLogs {
				t.Fatalf("consumed (traces=%d logs=%d), want (traces=%d logs=%d)", traces, logs, tc.wantTraces, tc.wantLogs)
			}
			if got := rec.lastWorkspace(); got != workspaceID {
				t.Fatalf("consumed for workspace %q, want %q", got, workspaceID)
			}
		})
	}
}

func assertExportResponse(t *testing.T, path, contentType string, raw []byte) {
	t.Helper()

	json := contentType == contentTypeJSON
	var err error
	if path == "/v1/traces" {
		resp := ptraceotlp.NewExportResponse()
		if json {
			err = resp.UnmarshalJSON(raw)
		} else {
			err = resp.UnmarshalProto(raw)
		}
	} else {
		resp := plogotlp.NewExportResponse()
		if json {
			err = resp.UnmarshalJSON(raw)
		} else {
			err = resp.UnmarshalProto(raw)
		}
	}
	if err != nil {
		t.Fatalf("response body is not an OTLP export response: %v", err)
	}
}

func TestHTTPCountsAcceptedRecords(t *testing.T) {
	srv, _ := startServer(t)

	accepted := metrics.Accepted.WithLabelValues(workspaceID, metrics.SignalTraces)
	before := testutil.ToFloat64(accepted)

	body := mustMarshal(t, ptraceotlp.NewExportRequestFromTraces(traceFixture()).MarshalProto)
	resp := post(t, srv, httpRequest{path: "/v1/traces", contentType: contentTypeProto, body: body, bearer: "Bearer " + testKey})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	// The fixture holds two spans: the counter counts records, not requests.
	if delta := testutil.ToFloat64(accepted) - before; delta != 2 {
		t.Fatalf("obstack_ingest_accepted_total delta = %v, want 2", delta)
	}
}

func TestHTTPGarbageBodyIsOneBadRequest(t *testing.T) {
	cases := []struct {
		name        string
		path        string
		contentType string
		body        []byte
	}{
		{"garbage protobuf", "/v1/traces", contentTypeProto, []byte("this is not an OTLP payload")},
		{"garbage json", "/v1/traces", contentTypeJSON, []byte("{not json")},
		{"garbage logs protobuf", "/v1/logs", contentTypeProto, []byte{0xff, 0xff, 0xff, 0xff, 0x0a}},
		{"empty json", "/v1/logs", contentTypeJSON, nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, rec := startServer(t)

			dropped := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonDecode)
			before := testutil.ToFloat64(dropped)

			resp := post(t, srv, httpRequest{path: tc.path, contentType: tc.contentType, body: tc.body, bearer: "Bearer " + testKey})
			// D6: one 4xx, never a 5xx that would put the exporter into a
			// retry loop over the same unreadable bytes.
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", resp.StatusCode)
			}
			if delta := testutil.ToFloat64(dropped) - before; delta != 1 {
				t.Fatalf("obstack_ingest_dropped_total{reason=decode} delta = %v, want 1", delta)
			}
			if traces, logs := rec.counts(); traces != 0 || logs != 0 {
				t.Fatalf("consumer saw (traces=%d logs=%d) from a malformed payload", traces, logs)
			}
		})
	}
}

// A body that cannot be read at all — a broken gzip stream, or one whose
// decompressed size blows past the cap — is still telemetry lost after the
// service took the request, so it answers 4xx and counts a drop.
func TestHTTPUnreadableBodyIsCountedAndCapped(t *testing.T) {
	cases := []struct {
		name       string
		body       []byte
		wantStatus int
	}{
		{"broken gzip stream", []byte("this was never gzipped"), http.StatusBadRequest},
		// A few KiB on the wire, past the 16MiB cap once inflated.
		{"gzip bomb", gzipOf(t, make([]byte, 32<<20)), http.StatusRequestEntityTooLarge},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, rec := startServer(t)

			dropped := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonDecode)
			before := testutil.ToFloat64(dropped)

			httpReq, err := http.NewRequest(http.MethodPost, "http://"+srv.HTTPAddr()+"/v1/traces", bytes.NewReader(tc.body))
			if err != nil {
				t.Fatalf("build request: %v", err)
			}
			httpReq.Header.Set("Content-Type", contentTypeProto)
			httpReq.Header.Set("Content-Encoding", "gzip")
			httpReq.Header.Set("Authorization", "Bearer "+testKey)

			resp, err := http.DefaultClient.Do(httpReq)
			if err != nil {
				t.Fatalf("POST /v1/traces: %v", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != tc.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.wantStatus)
			}
			if delta := testutil.ToFloat64(dropped) - before; delta != 1 {
				t.Fatalf("obstack_ingest_dropped_total{reason=decode} delta = %v, want 1", delta)
			}
			if traces, logs := rec.counts(); traces != 0 || logs != 0 {
				t.Fatalf("consumer saw (traces=%d logs=%d) from an unreadable body", traces, logs)
			}
		})
	}
}

func gzipOf(t *testing.T, raw []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(raw); err != nil {
		t.Fatalf("gzip payload: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip payload: %v", err)
	}
	return buf.Bytes()
}

func TestHTTPRejectsBadKey(t *testing.T) {
	body := mustMarshal(t, ptraceotlp.NewExportRequestFromTraces(traceFixture()).MarshalProto)

	cases := []struct {
		name   string
		bearer string
	}{
		{"missing header", ""},
		{"unknown key", "Bearer ok_dev_nope"},
		{"wrong scheme", "Basic " + testKey},
		{"bare key", testKey},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, rec := startServer(t)

			for _, path := range []string{"/v1/traces", "/v1/logs"} {
				resp := post(t, srv, httpRequest{path: path, contentType: contentTypeProto, body: body, bearer: tc.bearer})
				if resp.StatusCode != http.StatusUnauthorized {
					t.Fatalf("POST %s status = %d, want 401", path, resp.StatusCode)
				}
			}
			if traces, logs := rec.counts(); traces != 0 || logs != 0 {
				t.Fatalf("consumer saw (traces=%d logs=%d) from an unauthenticated export", traces, logs)
			}
		})
	}
}

// OTLP/HTTP requires the google.rpc.Status body of an error to come back in the
// encoding the request used; a JSON exporter handed a protobuf Status logs a
// parse failure instead of the reason it was refused.
func TestHTTPErrorBodyUsesRequestEncoding(t *testing.T) {
	srv, _ := startServer(t)

	cases := []struct {
		name       string
		bearer     string
		body       []byte
		wantStatus int
	}{
		{"unauthorized", "Bearer ok_dev_nope", nil, http.StatusUnauthorized},
		{"malformed", "Bearer " + testKey, []byte("{not json"), http.StatusBadRequest},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := post(t, srv, httpRequest{path: "/v1/traces", contentType: contentTypeJSON, body: tc.body, bearer: tc.bearer})
			if resp.StatusCode != tc.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.wantStatus)
			}
			if got := resp.Header.Get("Content-Type"); got != contentTypeJSON {
				t.Fatalf("Content-Type = %q, want %q", got, contentTypeJSON)
			}
			raw, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatalf("read response: %v", err)
			}
			// protojson's rendering of google.rpc.Status: a numeric code and a
			// human-readable message. A protobuf body would not parse here at
			// all, which is the regression this pins.
			var st struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			}
			if err := json.Unmarshal(raw, &st); err != nil {
				t.Fatalf("error body is not a JSON google.rpc.Status: %v (%q)", err, raw)
			}
			if st.Message == "" {
				t.Fatalf("error body carries no message: %q", raw)
			}
		})
	}
}

// An encoding we do not speak is telemetry refused from a workspace we do know,
// which D26 counts as a drop — one per request, since the body is never read.
func TestHTTPRejectsUnsupportedContentType(t *testing.T) {
	srv, _ := startServer(t)
	body := mustMarshal(t, ptraceotlp.NewExportRequestFromTraces(traceFixture()).MarshalProto)

	dropped := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonUnsupported)
	before := testutil.ToFloat64(dropped)

	contentTypes := []string{"", "text/plain", "application/octet-stream"}
	for _, contentType := range contentTypes {
		resp := post(t, srv, httpRequest{path: "/v1/traces", contentType: contentType, body: body, bearer: "Bearer " + testKey})
		if resp.StatusCode != http.StatusUnsupportedMediaType {
			t.Fatalf("Content-Type %q status = %d, want 415", contentType, resp.StatusCode)
		}
	}
	if delta := testutil.ToFloat64(dropped) - before; delta != float64(len(contentTypes)) {
		t.Fatalf("obstack_ingest_dropped_total{reason=unsupported} delta = %v, want %d", delta, len(contentTypes))
	}

	// Auth still runs first: an unknown key is answered 401 and counts nothing,
	// so an unauthenticated caller cannot inflate a workspace's drops.
	resp := post(t, srv, httpRequest{path: "/v1/traces", contentType: "text/plain", body: body, bearer: "Bearer ok_dev_nope"})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unknown key with bad Content-Type status = %d, want 401", resp.StatusCode)
	}
	if delta := testutil.ToFloat64(dropped) - before; delta != float64(len(contentTypes)) {
		t.Fatalf("401 counted an unsupported drop: delta = %v", delta)
	}
}

// A consumer that panics must cost the service one request, not the process
// (D26). 500 is outside the OTLP/HTTP retryable set, so the exporter does not
// re-send the payload that caused it.
func TestHTTPPanicIsRecoveredAndCounted(t *testing.T) {
	srv := startServerWith(t, panicker{})
	body := mustMarshal(t, ptraceotlp.NewExportRequestFromTraces(traceFixture()).MarshalProto)

	dropped := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonPanic)
	before := testutil.ToFloat64(dropped)

	// Twice: the second request only gets an answer if the first panic left the
	// process serving.
	for i := range 2 {
		resp := post(t, srv, httpRequest{path: "/v1/traces", contentType: contentTypeProto, body: body, bearer: "Bearer " + testKey})
		if resp.StatusCode != http.StatusInternalServerError {
			t.Fatalf("request %d status = %d, want 500", i, resp.StatusCode)
		}
		if got := resp.Header.Get("Content-Type"); got != contentTypeProto {
			t.Fatalf("Content-Type = %q, want %q", got, contentTypeProto)
		}
	}
	if delta := testutil.ToFloat64(dropped) - before; delta != 2 {
		t.Fatalf("obstack_ingest_dropped_total{reason=panic} delta = %v, want 2", delta)
	}
}

// The two drops the receive path can count exactly land in their own health
// columns as well as in Prometheus (D162): the workspace's ingest-error count
// is a product surface, so it cannot only exist in a metrics endpoint the
// customer never sees. Panic drops deliberately do not join them — a handler
// that died mid-batch has no honest record count to add.
func TestHTTPDecodeAndUnsupportedDropsFeedTheHealthRow(t *testing.T) {
	srv, _, meter := startMetered(t, false, nil)
	body := mustMarshal(t, ptraceotlp.NewExportRequestFromTraces(traceFixture()).MarshalProto)

	resp := post(t, srv, httpRequest{path: "/v1/traces", contentType: contentTypeProto, body: []byte("not OTLP"), bearer: "Bearer " + testKey})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("malformed payload status = %d, want 400", resp.StatusCode)
	}
	resp = post(t, srv, httpRequest{path: "/v1/traces", contentType: "text/plain", body: body, bearer: "Bearer " + testKey})
	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("unsupported Content-Type status = %d, want 415", resp.StatusCode)
	}

	if got := meter.droppedRecords(t, metering.DropDecode); got != 1 {
		t.Errorf("dropped_decode metered = %d, want 1", got)
	}
	if got := meter.droppedRecords(t, metering.DropUnsupported); got != 1 {
		t.Errorf("dropped_unsupported metered = %d, want 1", got)
	}

	// An unknown key is refused before any of this: nobody without a key gets to
	// write rows into a workspace's health row.
	resp = post(t, srv, httpRequest{path: "/v1/traces", contentType: "text/plain", body: body, bearer: "Bearer ok_dev_nope"})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unknown key status = %d, want 401", resp.StatusCode)
	}
	if got := meter.droppedRecords(t, metering.DropUnsupported); got != 1 {
		t.Errorf("a 401 metered a drop: dropped_unsupported = %d, want 1", got)
	}
}

func TestHTTPRejectsOtherMethods(t *testing.T) {
	srv, _ := startServer(t)

	resp, err := http.Get("http://" + srv.HTTPAddr() + "/v1/traces")
	if err != nil {
		t.Fatalf("GET /v1/traces: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", resp.StatusCode)
	}
}
