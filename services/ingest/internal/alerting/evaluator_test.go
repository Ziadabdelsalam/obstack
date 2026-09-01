package alerting

import "testing"

// Hermetic half of T4 (the metrics.test.ts / retention_test.go posture):
// nothing here needs a server. The state machine and the eval legs are proven
// against real stores in integration_test.go.

// ---- the histogram quantile, pinned to the TS half's own fixtures ----------
//
// `histogramQuantile` is a PORT of apps/web/src/server/queries/metrics.ts's
// function of the same name: the alerting leg finalizes a histogram's merged
// bucket counts in Go, where the TS query layer finalizes the identical state
// for a chart. Nothing makes the two agree by construction, so the cases below
// are metrics.test.ts's own known distribution and expected values, copied
// verbatim — a drift on either side turns one of the two suites red.
var (
	knownBounds = []float64{0, 10, 20, 30, 40}
	knownCounts = []float64{0, 10, 10, 10, 10, 0}
)

func TestHistogramQuantileMatchesTheContractFixtures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		bounds []float64
		counts []float64
		q      float64
		want   float64
		ok     bool
	}{
		{"p50 of a uniform distribution", knownBounds, knownCounts, 0.5, 20, true},
		{"p90 interpolates inside its bucket", knownBounds, knownCounts, 0.9, 36, true},
		{"p25 lands exactly on a bucket edge", knownBounds, knownCounts, 0.25, 10, true},
		{"p12.5 lands halfway through a bucket", knownBounds, knownCounts, 0.125, 5, true},
		{"an all-empty histogram is a gap, never a zero", knownBounds, []float64{0, 0, 0, 0, 0, 0}, 0.5, 0, false},
		{"mass below the first bound clamps to it", knownBounds, []float64{5, 0, 0, 0, 0, 0}, 0.5, 0, true},
		{"mass above the last bound clamps to it", knownBounds, []float64{0, 0, 0, 0, 0, 5}, 0.5, 40, true},
		{"one open bucket has no boundary to report", []float64{}, []float64{5}, 0.5, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := histogramQuantile(tc.bounds, tc.counts, tc.q)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if ok && got != tc.want {
				t.Errorf("value = %v, want %v", got, tc.want)
			}
		})
	}
}

// ---- event composition (T2's stamp: structured fields, never a render clone) ----

func TestEventTextComposesFromStructuredFields(t *testing.T) {
	trace := mustCondition(t, `{"source":"trace","signal":"p95_ms","service":"checkout","window":"15m","op":">","threshold":8000}`)
	metric := mustCondition(t, `{"source":"metric","metric":"svc.cpu","type":"gauge","agg":"avg","window":"5m","op":">","threshold":80,"filters":{"env":"prod","region":"eu"}}`)

	for _, tc := range []struct {
		name       string
		rule       string
		cond       Condition
		obs        observation
		wantTitle  string
		wantDetail string
	}{
		{
			name:       "trace leg, firing",
			rule:       "p95 checkout",
			cond:       trace,
			obs:        observation{value: 9214, unit: "ms", hasData: true},
			wantTitle:  "p95 checkout: 9214ms > 8000ms",
			wantDetail: "p95_ms for service checkout over the last 15m measured 9214ms against a threshold of 8000ms.",
		},
		{
			name:      "metric leg, firing, filters sorted by key",
			rule:      "cpu hot",
			cond:      metric,
			obs:       observation{value: 93.5, unit: "%", hasData: true},
			wantTitle: "cpu hot: 93.5% > 80%",
			wantDetail: "svc.cpu (gauge avg) over the last 5m filtered to env=prod, region=eu " +
				"measured 93.5% against a threshold of 80%.",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			title, detail := firingText(tc.rule, tc.cond, tc.obs)
			if title != tc.wantTitle {
				t.Errorf("title = %q, want %q", title, tc.wantTitle)
			}
			if detail != tc.wantDetail {
				t.Errorf("detail = %q, want %q", detail, tc.wantDetail)
			}
		})
	}

	title, detail := resolutionText("p95 checkout", trace, observation{value: 42, unit: "ms", hasData: true})
	if title != "p95 checkout: resolved" {
		t.Errorf("resolution title = %q, want %q", title, "p95 checkout: resolved")
	}
	want := "p95_ms for service checkout over the last 15m measured 42ms, back within the 8000ms threshold."
	if detail != want {
		t.Errorf("resolution detail = %q, want %q", detail, want)
	}
}

func TestFormatObservedValueCarriesTheUnit(t *testing.T) {
	for _, tc := range []struct {
		value float64
		unit  string
		want  string
	}{
		{9214, "ms", "9214ms"},
		{25, "%", "25%"},
		{0.9312, "1", "0.9312"}, // OTLP's dimensionless unit renders bare
		{20, "", "20"},
		{93.456, "%", "93.46%"},
		{0, "ms", "0ms"},
	} {
		if got := formatObserved(tc.value, tc.unit); got != tc.want {
			t.Errorf("formatObserved(%v, %q) = %q, want %q", tc.value, tc.unit, got, tc.want)
		}
	}
}

func TestCrossedReadsTheOperator(t *testing.T) {
	for _, tc := range []struct {
		op        string
		observed  float64
		threshold float64
		want      bool
	}{
		{">", 10, 5, true},
		{">", 5, 5, false},
		{"<", 1, 5, true},
		{"<", 5, 5, false},
	} {
		if got := crossed(tc.op, tc.observed, tc.threshold); got != tc.want {
			t.Errorf("crossed(%q, %v, %v) = %v, want %v", tc.op, tc.observed, tc.threshold, got, tc.want)
		}
	}
}

func mustCondition(t *testing.T, raw string) Condition {
	t.Helper()
	c, err := ParseCondition([]byte(raw))
	if err != nil {
		t.Fatalf("parse %s: %v", raw, err)
	}
	return c
}
