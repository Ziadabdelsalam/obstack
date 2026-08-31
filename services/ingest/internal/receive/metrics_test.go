package receive_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metering"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/receive"
)

// metricsFixture is two resource metrics, one gauge data point each, so a
// test can tell "one export" from "two data points" — the unit
// obstack_ingest_accepted_total{signal=metrics} and RecordAcceptedMetrics
// count in.
func metricsFixture() pmetric.Metrics {
	md := pmetric.NewMetrics()
	for i, service := range []string{"demo-agent", "demo-worker"} {
		rm := md.ResourceMetrics().AppendEmpty()
		rm.Resource().Attributes().PutStr("service.name", service)
		metric := rm.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
		metric.SetName("queue.depth")
		dp := metric.SetEmptyGauge().DataPoints().AppendEmpty()
		dp.SetDoubleValue(float64(i))
		dp.SetTimestamp(pcommon.NewTimestampFromTime(time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)))
	}
	return md
}

func exportMetrics(t *testing.T, srv *receive.Server, md pmetric.Metrics) {
	t.Helper()

	body := mustMarshal(t, pmetricotlp.NewExportRequestFromMetrics(md).MarshalProto)
	resp := post(t, srv, httpRequest{path: "/v1/metrics", contentType: contentTypeProto, body: body, bearer: "Bearer " + testKey})
	if resp.StatusCode != 200 {
		t.Fatalf("POST /v1/metrics status = %d, want 200", resp.StatusCode)
	}
}

// The HTTP and gRPC wiring (T4's job, D3): both transports reach the same
// consume path pmetricotlp.RegisterGRPCServer/POST /v1/metrics were added
// for.
func TestHTTPAcceptsMetricsExport(t *testing.T) {
	srv, rec := startServer(t)

	accepted := metrics.Accepted.WithLabelValues(workspaceID, metrics.SignalMetrics)
	before := testutil.ToFloat64(accepted)

	exportMetrics(t, srv, metricsFixture())

	if got := rec.metricsCount(); got != 1 {
		t.Fatalf("consumer saw %d metrics exports, want 1", got)
	}
	if got := rec.lastWorkspace(); got != workspaceID {
		t.Fatalf("consumed for workspace %q, want %q", got, workspaceID)
	}
	if delta := testutil.ToFloat64(accepted) - before; delta != 2 {
		t.Fatalf("obstack_ingest_accepted_total{signal=metrics} delta = %v, want 2", delta)
	}
}

func TestGRPCAcceptsMetricsExport(t *testing.T) {
	srv, rec := startServer(t)
	conn := dial(t, srv)

	ctx, cancel := exportContext(t, "Bearer "+testKey)
	defer cancel()

	if _, err := pmetricotlp.NewGRPCClient(conn).Export(ctx, pmetricotlp.NewExportRequestFromMetrics(metricsFixture())); err != nil {
		t.Fatalf("export metrics: %v", err)
	}
	if got := rec.metricsCount(); got != 1 {
		t.Fatalf("consumer saw %d metrics exports, want 1", got)
	}
}

// TestMetricsNeverConsultsOverQuota is the D365/D368 proof this task owns:
// the metrics consume path never calls OverQuota, so an over-quota workspace
// still gets its whole export through and ReasonQuota never increments on a
// metrics POST — quota sampling is a traces/logs-only mechanism.
func TestMetricsNeverConsultsOverQuota(t *testing.T) {
	rec, meter := &recorder{}, &fakeMeter{}
	srv := start(t, serverOptions{consumer: rec, overQuota: true, meter: meter})

	dropped := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonQuota)
	before := testutil.ToFloat64(dropped)

	exportMetrics(t, srv, metricsFixture())

	if got := rec.metricsCount(); got != 1 {
		t.Fatalf("consumer saw %d metrics exports over quota, want 1 — metrics are never sampled", got)
	}
	if delta := testutil.ToFloat64(dropped) - before; delta != 0 {
		t.Fatalf("obstack_ingest_dropped_total{reason=quota} delta = %v, want 0 on a metrics export", delta)
	}
	if got := meter.droppedRecords(t, metering.DropQuota); got != 0 {
		t.Fatalf("dropped_quota metered = %d, want 0 on a metrics export", got)
	}
}

// TestCardinalityDropsAreCountedInPrometheusAndTheHealthRow is T2's seam
// analysis, T4's job: MetricRows' returned cardinality-drop count is metered
// through countDrop from receive.go, using the identity mapping never sees —
// both the Prometheus counter and the health column (via the fake Meter)
// fire from that one call.
func TestCardinalityDropsAreCountedInPrometheusAndTheHealthRow(t *testing.T) {
	rec, meter := &recorder{metricDrops: 3}, &fakeMeter{}
	srv := start(t, serverOptions{consumer: rec, meter: meter})

	dropped := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonCardinality)
	before := testutil.ToFloat64(dropped)

	exportMetrics(t, srv, metricsFixture())

	if delta := testutil.ToFloat64(dropped) - before; delta != 3 {
		t.Fatalf("obstack_ingest_dropped_total{reason=cardinality} delta = %v, want 3", delta)
	}
	if got := meter.droppedRecords(t, metering.DropCardinality); got != 3 {
		t.Fatalf("dropped_cardinality metered = %d, want 3", got)
	}
}

// What survives is metered under RecordAcceptedMetrics (D368), never
// RecordAccepted — metrics carry no quota and touch no usage_ledger cell;
// that proof is T3's, this is the count itself reaching the right call.
func TestAcceptedMetricsAreMeteredPerWorkspaceAndKey(t *testing.T) {
	rec, meter := &recorder{}, &fakeMeter{}
	srv := start(t, serverOptions{consumer: rec, meter: meter})

	exportMetrics(t, srv, metricsFixture())

	want := []acceptedMetricsCall{{workspaceID, keyID, 2}}
	if got := meter.acceptedMetricsCalls(); len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("accepted metrics metered %v, want %v", got, want)
	}
	// Metrics never touch the ledger-facing RecordAccepted call.
	if got := meter.acceptedCalls(); len(got) != 0 {
		t.Fatalf("RecordAccepted called %v from a metrics export; metrics must only ever call RecordAcceptedMetrics", got)
	}
}

// An export that carries no data points is not an export: no consumer call
// and no accepted series claiming a workspace sent something it did not —
// the same D26 posture traces/logs already hold.
func TestEmptyMetricsExportIsNotHandedOn(t *testing.T) {
	rec, meter := &recorder{}, &fakeMeter{}
	srv := start(t, serverOptions{consumer: rec, meter: meter})

	accepted := metrics.Accepted.WithLabelValues(workspaceID, metrics.SignalMetrics)
	before := testutil.ToFloat64(accepted)

	exportMetrics(t, srv, pmetric.NewMetrics())

	if got := rec.metricsCount(); got != 0 {
		t.Fatalf("consumer saw %d metrics exports from an empty payload, want 0", got)
	}
	if delta := testutil.ToFloat64(accepted) - before; delta != 0 {
		t.Fatalf("obstack_ingest_accepted_total{signal=metrics} delta = %v, want 0", delta)
	}
	if len(meter.acceptedMetricsCalls()) != 0 {
		t.Fatalf("metered %v accepted metrics from an empty export", meter.acceptedMetricsCalls())
	}
}

// The panic-recovery posture (D26) already proven for traces/logs extends to
// metrics without a line of its own — the shared recovery wraps every route.
func TestMetricsPanicIsRecoveredAndCounted(t *testing.T) {
	srv := startServerWith(t, panicker{})
	body := mustMarshal(t, pmetricotlp.NewExportRequestFromMetrics(metricsFixture()).MarshalProto)

	dropped := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonPanic)
	before := testutil.ToFloat64(dropped)

	resp := post(t, srv, httpRequest{path: "/v1/metrics", contentType: contentTypeProto, body: body, bearer: "Bearer " + testKey})
	if resp.StatusCode != 500 {
		t.Fatalf("panicking consumer: status = %d, want 500", resp.StatusCode)
	}
	if delta := testutil.ToFloat64(dropped) - before; delta != 1 {
		t.Fatalf("obstack_ingest_dropped_total{reason=panic} delta = %v, want 1", delta)
	}
}

// Auth parity: /v1/metrics and the gRPC metrics service are behind the same
// bearer-key check as traces and logs (D3/D100). The route is new and public,
// so the refusal is asserted directly rather than inferred from the shared
// wrapper — an unauthenticated export is answered 401 / Unauthenticated and
// never reaches the consumer.
func TestMetricsRejectBadKeyOnBothTransports(t *testing.T) {
	body := mustMarshal(t, pmetricotlp.NewExportRequestFromMetrics(metricsFixture()).MarshalProto)

	for _, tc := range []struct {
		name   string
		bearer string
	}{
		{"missing header", ""},
		{"unknown key", "Bearer ok_dev_nope"},
		{"wrong scheme", "Basic " + testKey},
		{"bare key", testKey},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, rec := startServer(t)

			resp := post(t, srv, httpRequest{path: "/v1/metrics", contentType: contentTypeProto, body: body, bearer: tc.bearer})
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("POST /v1/metrics status = %d, want 401", resp.StatusCode)
			}

			ctx, cancel := exportContext(t, tc.bearer)
			defer cancel()
			_, err := pmetricotlp.NewGRPCClient(dial(t, srv)).Export(ctx, pmetricotlp.NewExportRequestFromMetrics(metricsFixture()))
			if got := status.Code(err); got != codes.Unauthenticated {
				t.Fatalf("gRPC export metrics code = %s, want Unauthenticated", got)
			}

			if got := rec.metricsCount(); got != 0 {
				t.Fatalf("consumer saw %d metrics exports from an unauthenticated export", got)
			}
		})
	}
}
