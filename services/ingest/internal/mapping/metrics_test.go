package mapping_test

import (
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/mapping"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
)

// newGaugeMetrics returns a payload holding one gauge metric with one data
// point, so a test only has to describe the fields it cares about.
func newGaugeMetrics(name string, value float64, ts time.Time) pmetric.Metrics {
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	rm.Resource().Attributes().PutStr("service.name", "demo-agent")
	metric := rm.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	metric.SetName(name)
	dp := metric.SetEmptyGauge().DataPoints().AppendEmpty()
	dp.SetDoubleValue(value)
	dp.SetTimestamp(pcommon.NewTimestampFromTime(ts))
	return md
}

// newCumulativeSumMetrics returns a payload holding one cumulative,
// monotonic sum metric with one data point.
func newCumulativeSumMetrics(name string, value float64, startTime, ts time.Time) pmetric.Metrics {
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	rm.Resource().Attributes().PutStr("service.name", "demo-agent")
	metric := rm.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	metric.SetName(name)
	sum := metric.SetEmptySum()
	sum.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	sum.SetIsMonotonic(true)
	dp := sum.DataPoints().AppendEmpty()
	dp.SetDoubleValue(value)
	dp.SetStartTimestamp(pcommon.NewTimestampFromTime(startTime))
	dp.SetTimestamp(pcommon.NewTimestampFromTime(ts))
	return md
}

// newCumulativeHistogramMetrics returns a payload holding one cumulative
// histogram metric with one data point over the given explicit bounds.
func newCumulativeHistogramMetrics(name string, bounds []float64, counts []uint64, sum float64, count uint64, startTime, ts time.Time) pmetric.Metrics {
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	rm.Resource().Attributes().PutStr("service.name", "demo-agent")
	metric := rm.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	metric.SetName(name)
	hist := metric.SetEmptyHistogram()
	hist.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	dp := hist.DataPoints().AppendEmpty()
	dp.ExplicitBounds().FromRaw(bounds)
	dp.BucketCounts().FromRaw(counts)
	dp.SetSum(sum)
	dp.SetCount(count)
	dp.SetStartTimestamp(pcommon.NewTimestampFromTime(startTime))
	dp.SetTimestamp(pcommon.NewTimestampFromTime(ts))
	return md
}

var (
	t0 = time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	t1 = time.Date(2026, 9, 1, 12, 0, 10, 0, time.UTC)
	t2 = time.Date(2026, 9, 1, 12, 0, 20, 0, time.UTC)
)

// newTestCache pins the cache's clock to a fixed instant. D380 makes
// SeriesCache.Now — ingest wall-clock, never the point's own timestamp — the
// sole driver of lastSeen/ActiveCount/reap; without pinning it, every test
// below would run against the real calendar date and go red as soon as that
// date drifted away from whatever "today" was when the test was written.
// Tests about the window/cap itself override Now again to move it forward.
func newTestCache(capacity int) *mapping.SeriesCache {
	c := mapping.NewSeriesCache(capacity)
	c.Now = func() time.Time { return t0 }
	return c
}

// noCapPressure is a cap so far above anything a test exercises that D376
// admission never rejects a point — used by every test that is not itself
// about the cap.
const noCapPressure = 1000

// Gauges pass through untouched — no cache state, no suppressed first point.
func TestGaugePassesThroughUnchanged(t *testing.T) {
	cache := newTestCache(noCapPressure)
	md := newGaugeMetrics("queue.depth", 42.5, t0)

	rows, _ := mapping.MetricRows(workspaceID, md, cache)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	row := rows[0]
	if row.Type != mapping.MetricTypeGauge || row.Value != 42.5 {
		t.Errorf("row = %+v, want type=gauge value=42.5", row)
	}
	if row.Name != "queue.depth" || row.Service != "demo-agent" {
		t.Errorf("name/service = %q/%q", row.Name, row.Service)
	}
	if !row.Timestamp.Equal(t0) {
		t.Errorf("timestamp = %s, want %s", row.Timestamp, t0)
	}

	// A second gauge point for the same series still emits, unlike a
	// cumulative series' first observation.
	rows, _ = mapping.MetricRows(workspaceID, newGaugeMetrics("queue.depth", 7, t1), cache)
	if len(rows) != 1 || rows[0].Value != 7 {
		t.Fatalf("second gauge point: rows = %+v, want one row value=7", rows)
	}
}

// Contract test: a cumulative series' first observation registers the series
// and emits no row — there is nothing to take a delta against yet.
func TestCumulativeSumFirstObservationEmitsNoRow(t *testing.T) {
	cache := newTestCache(noCapPressure)
	md := newCumulativeSumMetrics("requests.total", 100, t0, t0)

	rows, _ := mapping.MetricRows(workspaceID, md, cache)
	if len(rows) != 0 {
		t.Fatalf("got %d rows, want 0 on first observation", len(rows))
	}
	// The series is registered even though no row landed — it counts toward
	// the active-series total the cap enforcement reads.
	if got := cache.ActiveCount(workspaceID); got != 1 {
		t.Errorf("ActiveCount = %d, want 1", got)
	}
}

// Contract test: reset detected by the value dropping below the previous
// observation (same start_time) emits the raw value as the delta, not a
// negative subtraction.
func TestCumulativeSumResetByValueDropEmitsRawValue(t *testing.T) {
	cache := newTestCache(noCapPressure)

	first, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 100, t0, t0), cache)
	if len(first) != 0 {
		t.Fatalf("first observation: got %d rows, want 0", len(first))
	}

	// Same start_time, but the counter's raw value went backwards — an SDK
	// counter reset without a start_time bump.
	second, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 40, t0, t1), cache)
	if len(second) != 1 {
		t.Fatalf("got %d rows, want 1", len(second))
	}
	if got := second[0].Value; got != 40 {
		t.Errorf("delta = %v, want 40 (the raw value, not 40-100)", got)
	}

	// The series continues normally after the reset baseline.
	third, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 55, t0, t2), cache)
	if len(third) != 1 || third[0].Value != 15 {
		t.Fatalf("post-reset delta = %+v, want 15", third)
	}
}

// Contract test: reset detected by start_time changing (the SDK process
// restarted) emits the raw value as the delta even though the value itself
// increased and would otherwise look like a normal step.
func TestCumulativeSumResetByStartTimeChangeEmitsRawValue(t *testing.T) {
	cache := newTestCache(noCapPressure)

	first, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 100, t0, t0), cache)
	if len(first) != 0 {
		t.Fatalf("first observation: got %d rows, want 0", len(first))
	}

	// New start_time (t1), value nominally higher than before (150 > 100) —
	// a naive delta would say 50, but the process restarted so 100 of that
	// "history" never happened in this window.
	second, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 150, t1, t1), cache)
	if len(second) != 1 {
		t.Fatalf("got %d rows, want 1", len(second))
	}
	if got := second[0].Value; got != 150 {
		t.Errorf("delta = %v, want 150 (the raw value, not 150-100)", got)
	}
}

// Normal case: no reset, delta is current minus previous.
func TestCumulativeSumNormalDelta(t *testing.T) {
	cache := newTestCache(noCapPressure)
	mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 100, t0, t0), cache)

	rows, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 130, t0, t1), cache)
	if len(rows) != 1 || rows[0].Value != 30 {
		t.Fatalf("rows = %+v, want one row value=30", rows)
	}
	if !rows[0].IsMonotonic {
		t.Error("is_monotonic did not carry through from the Sum")
	}
}

// A delta-temporality sum passes through unchanged and never suppresses its
// first point — only cumulative series register-then-wait.
func TestDeltaSumPassesThroughUnchanged(t *testing.T) {
	cache := newTestCache(noCapPressure)
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	rm.Resource().Attributes().PutStr("service.name", "demo-agent")
	metric := rm.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	metric.SetName("errors.count")
	sum := metric.SetEmptySum()
	sum.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	dp := sum.DataPoints().AppendEmpty()
	dp.SetIntValue(5)
	dp.SetTimestamp(pcommon.NewTimestampFromTime(t0))

	rows, _ := mapping.MetricRows(workspaceID, md, cache)
	if len(rows) != 1 || rows[0].Value != 5 {
		t.Fatalf("rows = %+v, want one row value=5", rows)
	}
}

// Contract test: cumulative-histogram bucket subtraction. bucket_counts,
// h_sum and h_count subtract; bounds and h_min/h_max pass through raw.
func TestCumulativeHistogramBucketSubtraction(t *testing.T) {
	cache := newTestCache(noCapPressure)
	bounds := []float64{10, 50, 100}

	first, _ := mapping.MetricRows(workspaceID,
		newCumulativeHistogramMetrics("request.duration", bounds, []uint64{2, 5, 1, 0}, 120, 8, t0, t0),
		cache)
	if len(first) != 0 {
		t.Fatalf("first observation: got %d rows, want 0", len(first))
	}

	second, _ := mapping.MetricRows(workspaceID,
		newCumulativeHistogramMetrics("request.duration", bounds, []uint64{3, 9, 3, 1}, 260, 16, t0, t1),
		cache)
	if len(second) != 1 {
		t.Fatalf("got %d rows, want 1", len(second))
	}
	row := second[0]
	wantCounts := []uint64{1, 4, 2, 1}
	for i, want := range wantCounts {
		if row.BucketCounts[i] != want {
			t.Errorf("bucket_counts[%d] = %d, want %d (full: %v)", i, row.BucketCounts[i], want, row.BucketCounts)
		}
	}
	if row.HSum != 140 {
		t.Errorf("h_sum = %v, want 140", row.HSum)
	}
	if row.HCount != 8 {
		t.Errorf("h_count = %v, want 8", row.HCount)
	}
	if len(row.Bounds) != 3 || row.Bounds[0] != 10 || row.Bounds[2] != 100 {
		t.Errorf("bounds = %v, want %v", row.Bounds, bounds)
	}
}

// A cumulative histogram reset (bucket counts went backwards) emits the raw
// snapshot as the delta, per field, same as the sum's reset rule.
func TestCumulativeHistogramResetEmitsRawSnapshot(t *testing.T) {
	cache := newTestCache(noCapPressure)
	bounds := []float64{10, 50}

	mapping.MetricRows(workspaceID,
		newCumulativeHistogramMetrics("request.duration", bounds, []uint64{5, 5, 5}, 500, 15, t0, t0),
		cache)

	rows, _ := mapping.MetricRows(workspaceID,
		newCumulativeHistogramMetrics("request.duration", bounds, []uint64{1, 1, 1}, 30, 3, t0, t1),
		cache)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	row := rows[0]
	for i, want := range []uint64{1, 1, 1} {
		if row.BucketCounts[i] != want {
			t.Errorf("bucket_counts[%d] = %d, want %d (raw snapshot)", i, row.BucketCounts[i], want)
		}
	}
	if row.HSum != 30 || row.HCount != 3 {
		t.Errorf("h_sum/h_count = %v/%v, want 30/3 (raw snapshot)", row.HSum, row.HCount)
	}
}

// Contract test: a data point carrying more than the 64-attribute limit is
// dropped whole (ReasonMapping) — a partial attribute set would corrupt the
// series identity it belongs to.
func TestOverAttrLimitPointIsDroppedAndCounted(t *testing.T) {
	counter := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonMapping)
	before := testutil.ToFloat64(counter)

	cache := newTestCache(noCapPressure)
	md := newGaugeMetrics("queue.depth", 1, t0)
	dp := md.ResourceMetrics().At(0).ScopeMetrics().At(0).Metrics().At(0).Gauge().DataPoints().At(0)
	for i := 0; i < 65; i++ {
		dp.Attributes().PutStr(string(rune('a'+i%26))+string(rune('0'+i/26)), "v")
	}

	rows, _ := mapping.MetricRows(workspaceID, md, cache)
	if len(rows) != 0 {
		t.Fatalf("got %d rows, want 0", len(rows))
	}
	if delta := testutil.ToFloat64(counter) - before; delta != 1 {
		t.Errorf("mapping drop delta = %v, want 1", delta)
	}
	// The dropped point must not have touched the cache — it never had a
	// valid identity to register.
	if got := cache.ActiveCount(workspaceID); got != 0 {
		t.Errorf("ActiveCount = %d, want 0 — the dropped point registered a series", got)
	}
}

// Two data points differing only in their own attributes are different
// series (D363 §1) — same name, same service.
func TestSeriesHashDistinguishesPointAttributes(t *testing.T) {
	cache := newTestCache(noCapPressure)
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	rm.Resource().Attributes().PutStr("service.name", "demo-agent")
	metric := rm.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	metric.SetName("http.requests")
	gauge := metric.SetEmptyGauge()

	dp1 := gauge.DataPoints().AppendEmpty()
	dp1.SetTimestamp(pcommon.NewTimestampFromTime(t0))
	dp1.Attributes().PutStr("route", "/a")
	dp1.SetDoubleValue(1)

	dp2 := gauge.DataPoints().AppendEmpty()
	dp2.SetTimestamp(pcommon.NewTimestampFromTime(t0))
	dp2.Attributes().PutStr("route", "/b")
	dp2.SetDoubleValue(2)

	rows, _ := mapping.MetricRows(workspaceID, md, cache)
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[0].SeriesHash == rows[1].SeriesHash {
		t.Error("two data points with different attributes hashed to the same series")
	}
	if got := cache.ActiveCount(workspaceID); got != 2 {
		t.Errorf("ActiveCount = %d, want 2", got)
	}
}

// Attribute-KV order must not matter: sorting by key before hashing is what
// makes the identity a function of the attribute SET, not its wire order.
func TestSeriesHashIsOrderIndependent(t *testing.T) {
	build := func(routeFirst bool) pmetric.Metrics {
		md := pmetric.NewMetrics()
		rm := md.ResourceMetrics().AppendEmpty()
		rm.Resource().Attributes().PutStr("service.name", "demo-agent")
		metric := rm.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
		metric.SetName("http.requests")
		dp := metric.SetEmptyGauge().DataPoints().AppendEmpty()
		dp.SetTimestamp(pcommon.NewTimestampFromTime(t0))
		attrs := dp.Attributes()
		// Same KV pairs (route="r", status="s") both times — only the PutStr
		// call order differs.
		if routeFirst {
			attrs.PutStr("route", "r")
			attrs.PutStr("status", "s")
		} else {
			attrs.PutStr("status", "s")
			attrs.PutStr("route", "r")
		}
		return md
	}

	a, _ := mapping.MetricRows(workspaceID, build(true), newTestCache(noCapPressure))
	b, _ := mapping.MetricRows(workspaceID, build(false), newTestCache(noCapPressure))
	if len(a) != 1 || len(b) != 1 {
		t.Fatalf("got %d/%d rows, want 1/1", len(a), len(b))
	}
	if a[0].SeriesHash != b[0].SeriesHash {
		t.Error("attribute insertion order changed the series hash")
	}
}

// Unsupported metric types (no column shape in the D363 raw table) are
// dropped per data point and counted, same posture as every other mapping
// drop — the export's other metrics still land.
func TestUnsupportedMetricTypeIsDroppedAndCounted(t *testing.T) {
	counter := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonMapping)
	before := testutil.ToFloat64(counter)

	cache := newTestCache(noCapPressure)
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	sm := rm.ScopeMetrics().AppendEmpty()

	summary := sm.Metrics().AppendEmpty()
	summary.SetName("legacy.summary")
	summary.SetEmptySummary().DataPoints().AppendEmpty()

	expo := sm.Metrics().AppendEmpty()
	expo.SetName("exponential.duration")
	expo.SetEmptyExponentialHistogram().DataPoints().AppendEmpty()

	keeper := sm.Metrics().AppendEmpty()
	keeper.SetName("queue.depth")
	dp := keeper.SetEmptyGauge().DataPoints().AppendEmpty()
	dp.SetDoubleValue(1)
	dp.SetTimestamp(pcommon.NewTimestampFromTime(t0))

	rows, _ := mapping.MetricRows(workspaceID, md, cache)
	if len(rows) != 1 || rows[0].Name != "queue.depth" {
		t.Fatalf("got %d rows, want the one mappable gauge", len(rows))
	}
	if delta := testutil.ToFloat64(counter) - before; delta != 2 {
		t.Errorf("mapping drop delta = %v, want 2 (summary + exponential histogram)", delta)
	}
}

// The series hash is persisted in obstack.metric_points and every rollup keyed
// on it, so it must be stable across process restarts AND across changes to
// this package — a series whose hash moves silently splits into two in the
// rollups and twice in the catalog. This pins the exact value for a known
// (name, service, sorted attrs) triple: a change in the hash function, in the
// length-prefixed field framing, or in which fields feed the hash breaks it on
// purpose.
func TestSeriesHashGoldenValueIsStable(t *testing.T) {
	build := func() pmetric.Metrics {
		md := newGaugeMetrics("queue.depth", 1, t0)
		dp := md.ResourceMetrics().At(0).ScopeMetrics().At(0).Metrics().At(0).Gauge().DataPoints().At(0)
		dp.Attributes().PutStr("route", "/a")
		dp.Attributes().PutStr("status", "200")
		return md
	}

	rows, _ := mapping.MetricRows(workspaceID, build(), newTestCache(noCapPressure))
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	const want = uint64(0x486361b149902e2e) // name+type+service+sorted mapUpdate(resource,point) attrs, SipHash-2-4, zero key (D375/D378)
	if rows[0].SeriesHash != want {
		t.Errorf("series_hash = %#016x, want %#016x — the persisted series identity moved", rows[0].SeriesHash, want)
	}

	// D375: resource attributes now feed the hash via mapUpdate — a resource
	// attribute the point does not already carry (no key collision) changes
	// the series.
	distinctResourceAttr := build()
	distinctResourceAttr.ResourceMetrics().At(0).Resource().Attributes().PutStr("k8s.pod.name", "demo-agent-7f9")
	distinctRows, _ := mapping.MetricRows(workspaceID, distinctResourceAttr, newTestCache(noCapPressure))
	if len(distinctRows) != 1 || distinctRows[0].SeriesHash == want {
		t.Errorf("a new resource attribute did not change the series hash (D375): %+v", distinctRows)
	}

	// D375: point attributes win key collisions — a resource attribute whose
	// KEY the point already carries is fully shadowed, so it must not move
	// the hash away from `want` no matter what value the resource side holds.
	collidingResourceAttr := build()
	collidingResourceAttr.ResourceMetrics().At(0).Resource().Attributes().PutStr("route", "/resource-should-be-shadowed")
	collidingRows, _ := mapping.MetricRows(workspaceID, collidingResourceAttr, newTestCache(noCapPressure))
	if len(collidingRows) != 1 || collidingRows[0].SeriesHash != want {
		t.Errorf("a colliding resource attribute leaked into the hash instead of being shadowed by the point's value (D375): %+v", collidingRows)
	}
}

// A delta-temporality histogram passes through unchanged — counts, sum and
// count are already per-window — and never suppresses its first point.
func TestDeltaHistogramPassesThroughUnchanged(t *testing.T) {
	cache := newTestCache(noCapPressure)
	md := newCumulativeHistogramMetrics("request.duration", []float64{10, 50}, []uint64{1, 2, 3}, 90, 6, t0, t0)
	md.ResourceMetrics().At(0).ScopeMetrics().At(0).Metrics().At(0).Histogram().
		SetAggregationTemporality(pmetric.AggregationTemporalityDelta)

	rows, _ := mapping.MetricRows(workspaceID, md, cache)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1 (delta histograms do not register-then-wait)", len(rows))
	}
	row := rows[0]
	for i, want := range []uint64{1, 2, 3} {
		if row.BucketCounts[i] != want {
			t.Errorf("bucket_counts[%d] = %d, want %d", i, row.BucketCounts[i], want)
		}
	}
	if row.HSum != 90 || row.HCount != 6 {
		t.Errorf("h_sum/h_count = %v/%v, want 90/6", row.HSum, row.HCount)
	}
	if got := cache.ActiveCount(workspaceID); got != 1 {
		t.Errorf("ActiveCount = %d, want 1", got)
	}
}

// A cumulative histogram whose bucket layout changes mid-series (the SDK was
// reconfigured with different explicit bounds) cannot be subtracted against
// the previous snapshot — elementwise subtraction over mismatched lengths is
// meaningless. It is treated as a reset: the raw snapshot IS the delta.
func TestCumulativeHistogramBucketLayoutChangeIsReset(t *testing.T) {
	cache := newTestCache(noCapPressure)

	mapping.MetricRows(workspaceID,
		newCumulativeHistogramMetrics("request.duration", []float64{10, 50}, []uint64{5, 5, 5}, 500, 15, t0, t0),
		cache)

	// Three bounds instead of two -> four buckets instead of three.
	rows, _ := mapping.MetricRows(workspaceID,
		newCumulativeHistogramMetrics("request.duration", []float64{10, 50, 100}, []uint64{7, 7, 7, 7}, 900, 28, t0, t1),
		cache)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	row := rows[0]
	if len(row.BucketCounts) != 4 {
		t.Fatalf("bucket_counts = %v, want the 4-bucket raw snapshot", row.BucketCounts)
	}
	for i, want := range []uint64{7, 7, 7, 7} {
		if row.BucketCounts[i] != want {
			t.Errorf("bucket_counts[%d] = %d, want %d (raw snapshot)", i, row.BucketCounts[i], want)
		}
	}
	if row.HSum != 900 || row.HCount != 28 {
		t.Errorf("h_sum/h_count = %v/%v, want 900/28 (raw snapshot)", row.HSum, row.HCount)
	}
	if len(row.Bounds) != 3 {
		t.Errorf("bounds = %v, want the new 3-bound layout", row.Bounds)
	}
}

// Binding regression (D375): two resources sharing a metric name and
// identical point attributes are two different series once resource
// attributes feed the hash — the pre-D375 formula would have merged them
// into one and corrupted both streams' deltas. Cumulative points for the two
// streams are interleaved through the SAME cache to prove neither series'
// state leaks into the other's.
func TestTwoResourcesWithIdenticalPointAttrsAreIndependentSeries(t *testing.T) {
	cache := newTestCache(noCapPressure)

	buildSum := func(pod string, value float64, startTime, ts time.Time) pmetric.Metrics {
		md := pmetric.NewMetrics()
		rm := md.ResourceMetrics().AppendEmpty()
		rm.Resource().Attributes().PutStr("service.name", "demo-agent")
		rm.Resource().Attributes().PutStr("k8s.pod.name", pod)
		metric := rm.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
		metric.SetName("requests.total")
		sum := metric.SetEmptySum()
		sum.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
		dp := sum.DataPoints().AppendEmpty()
		dp.Attributes().PutStr("route", "/a") // identical point attrs on both resources
		dp.SetDoubleValue(value)
		dp.SetStartTimestamp(pcommon.NewTimestampFromTime(startTime))
		dp.SetTimestamp(pcommon.NewTimestampFromTime(ts))
		return md
	}

	// First observation each — registers two series, not one.
	mapping.MetricRows(workspaceID, buildSum("pod-1", 100, t0, t0), cache)
	mapping.MetricRows(workspaceID, buildSum("pod-2", 50, t0, t0), cache)
	if got := cache.ActiveCount(workspaceID); got != 2 {
		t.Fatalf("ActiveCount = %d, want 2 — identical point attrs under two resources must be two series (D375)", got)
	}

	// Interleave normal deltas across the two streams through the one cache.
	rowsA1, _ := mapping.MetricRows(workspaceID, buildSum("pod-1", 130, t0, t1), cache)
	rowsB1, _ := mapping.MetricRows(workspaceID, buildSum("pod-2", 80, t0, t1), cache)
	rowsA2, _ := mapping.MetricRows(workspaceID, buildSum("pod-1", 145, t0, t2), cache)
	rowsB2, _ := mapping.MetricRows(workspaceID, buildSum("pod-2", 130, t0, t2), cache)

	if len(rowsA1) != 1 || rowsA1[0].Value != 30 {
		t.Fatalf("pod-1 delta 1 = %+v, want one row value=30", rowsA1)
	}
	if len(rowsB1) != 1 || rowsB1[0].Value != 30 {
		t.Fatalf("pod-2 delta 1 = %+v, want one row value=30", rowsB1)
	}
	if len(rowsA2) != 1 || rowsA2[0].Value != 15 {
		t.Fatalf("pod-1 delta 2 = %+v, want one row value=15 (145-130, not against pod-2's state)", rowsA2)
	}
	if len(rowsB2) != 1 || rowsB2[0].Value != 50 {
		t.Fatalf("pod-2 delta 2 = %+v, want one row value=50 (130-80, not against pod-1's state)", rowsB2)
	}
	if rowsA1[0].SeriesHash == rowsB1[0].SeriesHash {
		t.Error("two different resources hashed to the same series")
	}
}

// D376 admission: a brand-new series arriving while the workspace is at cap
// is dropped and counted (cap reject) with NO cache entry allocated
// (no-entry-on-reject), while the series that already occupies the cap
// keeps being admitted regardless (established-survives-at-cap).
func TestCapRejectsNewSeriesButKeepsEstablishedAdmitted(t *testing.T) {
	cache := newTestCache(1)
	counter := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonCardinality)
	before := testutil.ToFloat64(counter)

	first, drops := mapping.MetricRows(workspaceID, newGaugeMetrics("metric.a", 1, t0), cache)
	if len(first) != 1 || drops != 0 {
		t.Fatalf("got %d rows / %d cardinality drops, want 1/0", len(first), drops)
	}
	if got := cache.ActiveCount(workspaceID); got != 1 {
		t.Fatalf("ActiveCount = %d, want 1", got)
	}

	// cap reject: a distinct, never-seen series with the cap full.
	second, drops := mapping.MetricRows(workspaceID, newGaugeMetrics("metric.b", 1, t0), cache)
	if len(second) != 0 {
		t.Fatalf("got %d rows, want 0 — the workspace is at cap", len(second))
	}
	if drops != 1 {
		t.Errorf("cardinality drops = %d, want 1 returned to the consumer (D376)", drops)
	}
	// D376: mapping returns the count and does NOT fire the Prometheus leg —
	// receive's countDrop is the one call site that fires both that counter and
	// the workspace's api_key_health.dropped_cardinality column, so counting
	// here too would double-count one surface and still leave the other empty.
	if delta := testutil.ToFloat64(counter) - before; delta != 0 {
		t.Errorf("mapping moved obstack_ingest_dropped_total{reason=cardinality} by %v; the consumer owns that leg", delta)
	}
	// no-entry-on-reject: the rejected series must not have taken the slot
	// that would let it flap in and out of "established".
	if got := cache.ActiveCount(workspaceID); got != 1 {
		t.Errorf("ActiveCount = %d, want 1 — a rejected series must allocate no entry (D376, binding)", got)
	}

	// established-survives-at-cap: metric.a keeps being admitted at cap.
	third, _ := mapping.MetricRows(workspaceID, newGaugeMetrics("metric.a", 2, t0), cache)
	if len(third) != 1 || third[0].Value != 2 {
		t.Fatalf("established series was rejected at cap: %+v", third)
	}

	// Retrying the rejected series again still rejects — deterministic, no
	// flapping (packet §2).
	fourth, _ := mapping.MetricRows(workspaceID, newGaugeMetrics("metric.b", 2, t0), cache)
	if len(fourth) != 0 {
		t.Fatalf("got %d rows, want 0 — metric.b must keep rejecting while metric.a holds the cap", len(fourth))
	}
}

// D376: Seed loads a hash as already-established (T4's boot reconciliation
// from obstack.metric_series) — it is admitted even though the cache starts
// at cap, and it counts toward ActiveCount immediately, while a genuinely
// new series is still rejected because the seed already spent the cap.
func TestSeedMakesSeriesEstablished(t *testing.T) {
	// Learn the hash a real series produces, the same way T4's boot query
	// would report it back from ClickHouse.
	discover, _ := mapping.MetricRows(workspaceID, newGaugeMetrics("queue.depth", 1, t0), newTestCache(noCapPressure))
	if len(discover) != 1 {
		t.Fatalf("got %d rows, want 1", len(discover))
	}
	hash := discover[0].SeriesHash

	cache := newTestCache(1)
	cache.Seed(workspaceID, []uint64{hash})
	if got := cache.ActiveCount(workspaceID); got != 1 {
		t.Fatalf("ActiveCount after Seed = %d, want 1", got)
	}

	// The seeded series is established: admitted even though the cache
	// starts "full" at cap=1.
	rows, _ := mapping.MetricRows(workspaceID, newGaugeMetrics("queue.depth", 2, t0), cache)
	if len(rows) != 1 {
		t.Fatalf("seeded series was rejected: got %d rows, want 1", len(rows))
	}

	// A genuinely new series is rejected — the seed already spent the cap.
	rejected, drops := mapping.MetricRows(workspaceID, newGaugeMetrics("other.metric", 1, t0), cache)
	if len(rejected) != 0 {
		t.Fatalf("got %d rows, want 0 — the cap was already spent by the seeded series", len(rejected))
	}
	if drops != 1 {
		t.Errorf("cardinality drops = %d, want 1", drops)
	}
}

// D377: ActiveCount counts only entries whose lastSeen — the cache's ingest
// wall-clock at admission (D380) — falls within the current UTC day; a
// series last admitted yesterday does not occupy today's cap even before it
// is evicted.
func TestActiveCountOnlyCountsTodaysSeries(t *testing.T) {
	cache := newTestCache(noCapPressure)
	cache.Now = func() time.Time { return t0 }

	mapping.MetricRows(workspaceID, newGaugeMetrics("metric.a", 1, t0), cache)
	if got := cache.ActiveCount(workspaceID); got != 1 {
		t.Fatalf("ActiveCount = %d, want 1", got)
	}

	// "Now" crosses into the next UTC day without the series being touched
	// again — it drops out of today's active count.
	nextDay := t0.Add(25 * time.Hour)
	cache.Now = func() time.Time { return nextDay }
	if got := cache.ActiveCount(workspaceID); got != 0 {
		t.Errorf("ActiveCount = %d, want 0 — the series' last_seen is not today", got)
	}
}

// Binding test (D380): the activity clock is ingest wall-clock, full stop —
// a producer cannot backdate its way around the cap. A stream whose points
// are all timestamped well before today's UTC midnight still counts toward
// ActiveCount and still trips the cap, because admission time — not the
// backdated data — is what stamps lastSeen. This must go red against the old
// point-timestamp behavior: there, lastSeen would be the backdated point's
// own timestamp, ActiveCount would read 0 for "today", and the second series
// below would be admitted instead of rejected.
func TestActivityClockIsIngestWallClockNotPointTimestamp(t *testing.T) {
	cache := mapping.NewSeriesCache(1)
	cache.Now = func() time.Time { return t0 } // "now" at admission time

	backdated := t0.Add(-72 * time.Hour) // the point's own timestamp: three days before "now"
	first, _ := mapping.MetricRows(workspaceID, newGaugeMetrics("metric.a", 1, backdated), cache)
	if len(first) != 1 {
		t.Fatalf("got %d rows, want 1", len(first))
	}

	// Backdated data still counts as active today — admission time, not data
	// time, stamps lastSeen (D380).
	if got := cache.ActiveCount(workspaceID); got != 1 {
		t.Fatalf("ActiveCount = %d, want 1 — a backdated point still admits at ingest wall-clock (D380)", got)
	}

	// And it still trips the cap: a second, distinct series is rejected even
	// though the first series' own data claims to be three days old.
	rejected, drops := mapping.MetricRows(workspaceID, newGaugeMetrics("metric.b", 1, backdated), cache)
	if len(rejected) != 0 {
		t.Fatalf("got %d rows, want 0 — the cap must be tripped by wall-clock admission, not point time", len(rejected))
	}
	if drops != 1 {
		t.Errorf("cardinality drops = %d, want 1", drops)
	}
}

// D377: a cumulative stream silent more than 24h is reaped and re-enters as
// a first observation — one dropped delta point, ruled correct — rather than
// resuming its old cumulative state (which would compute a bogus delta
// against a value from a day-old, possibly-restarted process).
func TestIdleCumulativeSeriesReentersAsFirstObservationAfter24h(t *testing.T) {
	cache := newTestCache(noCapPressure)
	cache.Now = func() time.Time { return t0 }

	first, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 100, t0, t0), cache)
	if len(first) != 0 {
		t.Fatalf("first observation: got %d rows, want 0", len(first))
	}

	second, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 130, t0, t1), cache)
	if len(second) != 1 || second[0].Value != 30 {
		t.Fatalf("normal delta before idle: rows = %+v, want one row value=30", second)
	}

	// The stream falls silent more than 24h — the workspace's next export
	// arrives well past the idle threshold.
	later := t0.Add(25 * time.Hour)
	cache.Now = func() time.Time { return later }
	reentry, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 999, t0, later), cache)
	if len(reentry) != 0 {
		t.Fatalf("reentry after idle: got %d rows, want 0 (first observation again, D377)", len(reentry))
	}

	// It behaves as a brand-new series from here: the next point deltas
	// normally against the reentry baseline (999), never against the
	// pre-idle state (130).
	after, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 1020, t0, later.Add(10*time.Second)), cache)
	if len(after) != 1 || after[0].Value != 21 {
		t.Fatalf("post-reentry delta = %+v, want one row value=21 (1020-999)", after)
	}
}

// D377: every idle entry in the workspace is evicted, not only the one series
// a test happens to follow — two independently-idle series both reenter as
// first observations after 24h. (That eviction is a whole-workspace sweep
// rather than lazy per-entry expiry is a memory-residency property, which no
// exported API observes; what is asserted here is the behaviour every idle
// series shows.)
func TestReapEvictsEveryIdleSeriesInTheWorkspace(t *testing.T) {
	cache := newTestCache(noCapPressure)
	cache.Now = func() time.Time { return t0 }

	mapping.MetricRows(workspaceID, newCumulativeSumMetrics("a.total", 10, t0, t0), cache) // first observation
	mapping.MetricRows(workspaceID, newCumulativeSumMetrics("b.total", 20, t0, t0), cache) // first observation
	if got := cache.ActiveCount(workspaceID); got != 2 {
		t.Fatalf("ActiveCount = %d, want 2", got)
	}

	later := t0.Add(25 * time.Hour)
	cache.Now = func() time.Time { return later }

	// Only a.total is touched in this export; the sweep runs for the whole
	// workspace regardless, so b.total — untouched here — is reaped too.
	reentryA, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("a.total", 999, t0, later), cache)
	if len(reentryA) != 0 {
		t.Fatalf("a.total reentry: got %d rows, want 0 (first observation)", len(reentryA))
	}

	reentryB, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("b.total", 888, t0, later), cache)
	if len(reentryB) != 0 {
		t.Fatalf("b.total reentry: got %d rows, want 0 (first observation) — reap must sweep every idle entry, not only the one touched", len(reentryB))
	}
}

// A seeded series is established for the cap but holds no cumulative
// baseline: the first cumulative point after a restart must register that
// baseline and emit no row. Emitting instead would publish the counter's
// entire lifetime total as one delta — a permanent spike in every sum and
// rate chart on every ingest restart.
func TestSeededCumulativeSeriesTakesABaselineBeforeEmitting(t *testing.T) {
	// Learn the hash the way T4's boot query reports it back from ClickHouse.
	discover, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 1, t0, t0), newTestCache(noCapPressure))
	_ = discover
	warm := newTestCache(noCapPressure)
	mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 1, t0, t0), warm)
	known, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 2, t0, t1), warm)
	if len(known) != 1 {
		t.Fatalf("fixture: got %d rows, want 1", len(known))
	}

	cache := newTestCache(noCapPressure)
	cache.Seed(workspaceID, []uint64{known[0].SeriesHash})

	// The process restarted; the counter is at 10,000,000 and its history
	// belongs to rows this process already wrote before the restart.
	first, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 10_000_000, t0, t1), cache)
	if len(first) != 0 {
		t.Fatalf("seeded series emitted %+v on its first cumulative point; want no row (baseline only)", first)
	}

	// From the baseline on, deltas are ordinary.
	second, _ := mapping.MetricRows(workspaceID, newCumulativeSumMetrics("requests.total", 10_000_030, t0, t2), cache)
	if len(second) != 1 || second[0].Value != 30 {
		t.Fatalf("post-baseline delta = %+v, want one row value=30", second)
	}

	// Same rule for histograms: a seeded histogram series takes its bucket
	// snapshot first rather than emitting the whole cumulative histogram.
	histCache := newTestCache(noCapPressure)
	histWarm := newTestCache(noCapPressure)
	mapping.MetricRows(workspaceID, newCumulativeHistogramMetrics("request.duration", []float64{10}, []uint64{1, 1}, 20, 2, t0, t0), histWarm)
	histKnown, _ := mapping.MetricRows(workspaceID, newCumulativeHistogramMetrics("request.duration", []float64{10}, []uint64{2, 2}, 40, 4, t0, t1), histWarm)
	if len(histKnown) != 1 {
		t.Fatalf("fixture: got %d histogram rows, want 1", len(histKnown))
	}
	histCache.Seed(workspaceID, []uint64{histKnown[0].SeriesHash})
	histFirst, _ := mapping.MetricRows(workspaceID, newCumulativeHistogramMetrics("request.duration", []float64{10}, []uint64{5000, 5000}, 100000, 10000, t0, t1), histCache)
	if len(histFirst) != 0 {
		t.Fatalf("seeded histogram emitted %+v on its first point; want no row (baseline only)", histFirst)
	}
}
