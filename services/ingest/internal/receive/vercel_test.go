package receive_test

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // asserting the vendor's documented algorithm
	"encoding/hex"
	"net/http"
	"os"
	"strings"
	"testing"

	"go.opentelemetry.io/collector/pdata/plog"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metering"
)

// The drain fixtures are the vendor's published examples, captured verbatim —
// see testdata/vercel/PROVENANCE.md for what that does and does not prove
// (D285). Both encodings carry the same two entries: a build line with no trace
// context and a lambda line with it.
const vercelPath = "/v1/integrations/vercel"

func vercelFixture(t *testing.T, name string) []byte {
	t.Helper()
	body, err := os.ReadFile("testdata/vercel/" + name)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return body
}

// records flattens what the consumer received into the fields the mapping is
// about, in arrival order.
type drainRecord struct {
	body        string
	severity    plog.SeverityNumber
	traceID     string
	spanID      string
	serviceName string
	attrs       map[string]string
}

func drainRecords(t *testing.T, rec *recorder) []drainRecord {
	t.Helper()

	rec.mu.Lock()
	defer rec.mu.Unlock()

	var out []drainRecord
	for _, ld := range rec.logs {
		for i := range ld.ResourceLogs().Len() {
			rl := ld.ResourceLogs().At(i)
			service := ""
			if v, ok := rl.Resource().Attributes().Get("service.name"); ok {
				service = v.Str()
			}
			for j := range rl.ScopeLogs().Len() {
				records := rl.ScopeLogs().At(j).LogRecords()
				for k := range records.Len() {
					r := records.At(k)
					attrs := map[string]string{}
					for key, value := range r.Attributes().All() {
						attrs[key] = value.AsString()
					}
					traceID := ""
					if tid := r.TraceID(); !tid.IsEmpty() {
						traceID = hex.EncodeToString(tid[:])
					}
					spanID := ""
					if sid := r.SpanID(); !sid.IsEmpty() {
						spanID = hex.EncodeToString(sid[:])
					}
					out = append(out, drainRecord{
						body:        r.Body().AsString(),
						severity:    r.SeverityNumber(),
						traceID:     traceID,
						spanID:      spanID,
						serviceName: service,
						attrs:       attrs,
					})
				}
			}
		}
	}
	return out
}

func TestVercelDrainAcceptsBothEncodings(t *testing.T) {
	for _, tc := range []struct{ name, fixture string }{
		{"json", "logs.json"},
		{"ndjson", "logs.ndjson"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, rec := startServer(t)
			resp := post(t, srv, httpRequest{
				path:        vercelPath,
				contentType: contentTypeJSON,
				body:        vercelFixture(t, tc.fixture),
				bearer:      "Bearer " + testKey,
			})
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200", resp.StatusCode)
			}
			if got := drainRecords(t, rec); len(got) != 2 {
				t.Fatalf("consumed %d records, want the fixture's 2", len(got))
			}
			if got := rec.lastWorkspace(); got != workspaceID {
				t.Errorf("landed in workspace %q, want %q", got, workspaceID)
			}
		})
	}
}

// The correlation posture (D254): trace context comes from the measured fields
// and from nowhere else — the entry that carries none stays trace-less rather
// than being joined to something invented.
func TestVercelDrainExtractsOnlyMeasuredTraceContext(t *testing.T) {
	srv, rec := startServer(t)
	post(t, srv, httpRequest{
		path:        vercelPath,
		contentType: contentTypeJSON,
		body:        vercelFixture(t, "logs.ndjson"),
		bearer:      "Bearer " + testKey,
	})

	records := drainRecords(t, rec)
	if len(records) != 2 {
		t.Fatalf("consumed %d records, want 2", len(records))
	}

	var build, lambda drainRecord
	for _, r := range records {
		switch r.attrs["vercel.source"] {
		case "build":
			build = r
		case "lambda":
			lambda = r
		}
	}

	if build.traceID != "" || build.spanID != "" {
		t.Errorf("build line got trace context %q/%q, want none", build.traceID, build.spanID)
	}
	if lambda.traceID != "1b02cd14bb8642fd092bc23f54c7ffcd" {
		t.Errorf("lambda trace id = %q, want the payload's", lambda.traceID)
	}
	if lambda.spanID != "f24e8631bd11faa7" {
		t.Errorf("lambda span id = %q, want the payload's", lambda.spanID)
	}
	if lambda.attrs["http.response.status_code"] != "200" {
		t.Errorf("status code attribute = %q, want 200", lambda.attrs["http.response.status_code"])
	}
	if lambda.attrs["url.path"] != "/api/users" {
		t.Errorf("path attribute = %q", lambda.attrs["url.path"])
	}
	if build.serviceName != "my-app" {
		t.Errorf("service.name = %q, want the project name", build.serviceName)
	}
	if build.severity != plog.SeverityNumberInfo {
		t.Errorf("severity = %v, want INFO", build.severity)
	}
	if build.body != "Build completed successfully" {
		t.Errorf("body = %q", build.body)
	}
}

// vercelArrayBody wraps the fixture's entries in the bracketed array the
// measured `json` encoding delivers (VD: "json — an array of log objects"), so
// that shape is asserted over the vendor's own captured entries rather than
// over a payload written for the test.
func vercelArrayBody(t *testing.T) []byte {
	t.Helper()
	lines := bytes.Split(bytes.TrimSpace(vercelFixture(t, "logs.ndjson")), []byte("\n"))
	return append(append([]byte("["), bytes.Join(lines, []byte(","))...), ']')
}

// The bracketed array is the other half of the drain's `json` encoding, and the
// branch of the decoder that reads it: the fixtures are per-line, so without
// this case a real array delivery would be untested.
func TestVercelDrainAcceptsJSONArray(t *testing.T) {
	srv, rec := startServer(t)
	resp := post(t, srv, httpRequest{
		path:        vercelPath,
		contentType: contentTypeJSON,
		body:        vercelArrayBody(t),
		bearer:      "Bearer " + testKey,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	records := drainRecords(t, rec)
	if len(records) != 2 {
		t.Fatalf("consumed %d records from the array encoding, want 2", len(records))
	}
	var traced int
	for _, r := range records {
		if r.traceID != "" {
			traced++
		}
	}
	if traced != 1 {
		t.Errorf("%d records carry trace context, want the lambda line's", traced)
	}
}

// D291's "metering, health rows and drops ride free" made checkable: the route
// hands its records to the same consumeLogs the OTLP path uses, so the meter
// behind the per-key health rows (D99/D100) sees drain traffic attributed to
// the same workspace and key — and an entry the mapping refuses is counted in
// the same drop vocabulary rather than silently omitted.
func TestVercelDrainMetersAcceptedAndDropped(t *testing.T) {
	srv, _, meter := startMetered(t, false, nil)

	body := append(vercelFixture(t, "logs.ndjson"), []byte("\n"+`{"id":"c","level":"info","message":"no time"}`)...)
	resp := post(t, srv, httpRequest{
		path:        vercelPath,
		contentType: contentTypeJSON,
		body:        body,
		bearer:      "Bearer " + testKey,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	accepted := meter.acceptedCalls()
	if len(accepted) != 1 {
		t.Fatalf("%d metering calls, want the delivery's one", len(accepted))
	}
	if accepted[0].workspaceID != workspaceID || accepted[0].keyID != keyID {
		t.Errorf("metered as (%q, %q), want (%q, %q)",
			accepted[0].workspaceID, accepted[0].keyID, workspaceID, keyID)
	}
	if accepted[0].logs != 2 || accepted[0].spans != 0 {
		t.Errorf("metered %d logs / %d spans, want 2/0", accepted[0].logs, accepted[0].spans)
	}
	if got := meter.droppedRecords(t, metering.DropDecode); got != 1 {
		t.Errorf("metered %d decode drops, want the timestampless entry's 1", got)
	}
}

func TestVercelDrainAcceptsGzip(t *testing.T) {
	srv, rec := startServer(t)
	resp := post(t, srv, httpRequest{
		path:        vercelPath,
		contentType: contentTypeJSON,
		body:        vercelFixture(t, "logs.ndjson"),
		bearer:      "Bearer " + testKey,
		gzipped:     true,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := drainRecords(t, rec); len(got) != 2 {
		t.Fatalf("consumed %d records through gzip, want 2", len(got))
	}
}

func TestVercelDrainRefusesWithoutKey(t *testing.T) {
	srv, rec := startServer(t)
	resp := post(t, srv, httpRequest{
		path:        vercelPath,
		contentType: contentTypeJSON,
		body:        vercelFixture(t, "logs.ndjson"),
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
	if _, logs := rec.counts(); logs != 0 {
		t.Errorf("consumed %d unauthenticated payloads, want 0", logs)
	}
}

func TestVercelDrainRefusesMalformedPayload(t *testing.T) {
	srv, rec := startServer(t)
	resp := post(t, srv, httpRequest{
		path:        vercelPath,
		contentType: contentTypeJSON,
		body:        []byte(`{"id": "x", "timestamp":`),
		bearer:      "Bearer " + testKey,
	})
	// One 4xx ends it (D6) — a 5xx would have the sender retry the same
	// unreadable bytes until the drain is disabled.
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if _, logs := rec.counts(); logs != 0 {
		t.Errorf("consumed %d malformed payloads, want 0", logs)
	}
}

// An entry with no usable timestamp cannot be a row; the rest of the delivery
// still lands.
func TestVercelDrainSkipsTimestamplessEntries(t *testing.T) {
	srv, rec := startServer(t)
	resp := post(t, srv, httpRequest{
		path:        vercelPath,
		contentType: contentTypeJSON,
		body: []byte(`{"id":"a","level":"info","message":"no time"}
{"id":"b","timestamp":1573817187330,"level":"error","message":"has time","projectName":"p"}`),
		bearer: "Bearer " + testKey,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	records := drainRecords(t, rec)
	if len(records) != 1 {
		t.Fatalf("consumed %d records, want only the timestamped one", len(records))
	}
	if records[0].severity != plog.SeverityNumberError {
		t.Errorf("severity = %v, want ERROR", records[0].severity)
	}
}

// D287: the signature check fires only when the secret is set, and a bad
// signature is refused even with a valid bearer key.
func TestVercelDrainVerifiesSignatureWhenConfigured(t *testing.T) {
	const secret = "obstack-test-drain-secret"
	body := vercelFixture(t, "logs.ndjson")
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write(body)
	good := hex.EncodeToString(mac.Sum(nil))

	for _, tc := range []struct {
		name      string
		signature string
		want      int
	}{
		{"valid signature", good, http.StatusOK},
		{"wrong signature", strings.Repeat("0", len(good)), http.StatusUnauthorized},
		{"missing signature", "", http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, _ := startSigningDrain(t, secret)
			resp := post(t, srv, httpRequest{
				path:        vercelPath,
				contentType: contentTypeJSON,
				body:        body,
				bearer:      "Bearer " + testKey,
				headers:     map[string]string{"X-Vercel-Signature": tc.signature},
			})
			if resp.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.want)
			}
		})
	}
}

// The signature is computed over the bytes as received: a gzipped delivery is
// verified before it is decompressed (D287), which is the only reading under
// which a sender and this receiver agree.
func TestVercelDrainVerifiesSignatureOverRawBytes(t *testing.T) {
	const secret = "obstack-test-drain-secret"
	body := vercelFixture(t, "logs.ndjson")
	compressed := gzipBytes(t, body)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write(compressed)
	overRaw := hex.EncodeToString(mac.Sum(nil))

	srv, rec := startSigningDrain(t, secret)
	resp := post(t, srv, httpRequest{
		path:          vercelPath,
		contentType:   contentTypeJSON,
		body:          compressed,
		bearer:        "Bearer " + testKey,
		preCompressed: true,
		headers:       map[string]string{"X-Vercel-Signature": overRaw},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 for a signature over the raw bytes", resp.StatusCode)
	}
	if got := drainRecords(t, rec); len(got) != 2 {
		t.Fatalf("consumed %d records, want 2", len(got))
	}
}
