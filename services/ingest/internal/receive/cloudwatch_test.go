package receive_test

import (
	"net/http"
	"os"
	"testing"

	"go.opentelemetry.io/collector/pdata/plog"
)

// The CloudWatch fixtures are the vendor's published payloads, captured
// verbatim — see testdata/cloudwatch/PROVENANCE.md (D285).
const cloudWatchPath = "/v1/integrations/cloudwatch"

func cloudWatchFixture(t *testing.T, name string) []byte {
	t.Helper()
	body, err := os.ReadFile("testdata/cloudwatch/" + name)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return body
}

func TestCloudWatchAcceptsDataMessage(t *testing.T) {
	srv, rec := startServer(t)
	resp := post(t, srv, httpRequest{
		path:        cloudWatchPath,
		contentType: contentTypeJSON,
		body:        cloudWatchFixture(t, "data-message.json"),
		bearer:      "Bearer " + testKey,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	records := drainRecords(t, rec)
	if len(records) != 3 {
		t.Fatalf("consumed %d records, want the fixture's 3", len(records))
	}
	if got := rec.lastWorkspace(); got != workspaceID {
		t.Errorf("landed in workspace %q, want %q", got, workspaceID)
	}
	if records[0].serviceName != "CloudTrail" {
		t.Errorf("service.name = %q, want the log group's name", records[0].serviceName)
	}
	if records[0].attrs["aws.cloudwatch.event.id"] == "" {
		t.Error("event id attribute missing")
	}
	// The envelope carries no trace context and none is invented (D254).
	for i, r := range records {
		if r.traceID != "" || r.spanID != "" {
			t.Errorf("record %d got trace context %q/%q, want none", i, r.traceID, r.spanID)
		}
		if r.severity != plog.SeverityNumberUnspecified {
			t.Errorf("record %d claimed severity %v; CloudWatch carries none", i, r.severity)
		}
	}
}

// The reachability probe is acknowledged and never metered: counting it would
// put an event on a workspace's usage that nobody sent.
func TestCloudWatchAcknowledgesControlMessage(t *testing.T) {
	srv, rec := startServer(t)
	resp := post(t, srv, httpRequest{
		path:        cloudWatchPath,
		contentType: contentTypeJSON,
		body:        cloudWatchFixture(t, "control-message.json"),
		bearer:      "Bearer " + testKey,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if _, logs := rec.counts(); logs != 0 {
		t.Errorf("consumed %d control messages as telemetry, want 0", logs)
	}
}

func TestCloudWatchRefusesWithoutKey(t *testing.T) {
	srv, rec := startServer(t)
	resp := post(t, srv, httpRequest{
		path:        cloudWatchPath,
		contentType: contentTypeJSON,
		body:        cloudWatchFixture(t, "data-message.json"),
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
	if _, logs := rec.counts(); logs != 0 {
		t.Errorf("consumed %d unauthenticated payloads, want 0", logs)
	}
}

func TestCloudWatchRefusesMalformedPayload(t *testing.T) {
	srv, rec := startServer(t)
	resp := post(t, srv, httpRequest{
		path:        cloudWatchPath,
		contentType: contentTypeJSON,
		body:        []byte(`{"messageType": "DATA_MESSAGE", "logEvents": [`),
		bearer:      "Bearer " + testKey,
	})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if _, logs := rec.counts(); logs != 0 {
		t.Errorf("consumed %d malformed payloads, want 0", logs)
	}
}

func TestCloudWatchSkipsTimestamplessEvents(t *testing.T) {
	srv, rec := startServer(t)
	resp := post(t, srv, httpRequest{
		path:        cloudWatchPath,
		contentType: contentTypeJSON,
		body: []byte(`{"messageType":"DATA_MESSAGE","logGroup":"/aws/lambda/checkout","logEvents":[
			{"id":"a","message":"no time"},
			{"id":"b","timestamp":1432826855000,"message":"has time"}]}`),
		bearer: "Bearer " + testKey,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	records := drainRecords(t, rec)
	if len(records) != 1 {
		t.Fatalf("consumed %d records, want only the timestamped one", len(records))
	}
	if records[0].serviceName != "checkout" {
		t.Errorf("service.name = %q, want the lambda's name from the log group", records[0].serviceName)
	}
}
