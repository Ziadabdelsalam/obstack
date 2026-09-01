package alerting

// eval_metric.go — the metric leg (D481): one aggregate over `metric_points_1m`
// for the condition's window, compared with the threshold by the state machine.
//
// The SQL below is the semantic sibling of
// `apps/web/src/server/queries/metrics.ts`'s `seriesSql`, and deliberately so:
// the chart and the alert must not be able to disagree about what "p95 of this
// histogram over this window" means. The house rules that file states are
// binding here too (the S6.1 rule binds Go):
//
//   - never FINAL, never a bare SELECT. `metric_points_1m` is an
//     AggregatingMergeTree fed one partial row per inserted block, so a read
//     that does not GROUP BY the series key with the matching combinators is
//     reading unmerged parts and UNDER-REPORTING.
//
//   - the two-level shape. The inner query merges each series over the window;
//     the outer folds the series together. `avg` and `argMax` and `sumForEach`
//     are re-emitted as -MergeState in the inner and finalized exactly once in
//     the outer, because an avg-of-avgs across the outer regroup is arithmetic
//     nobody wants under an alert. `sum`/`min`/`max`/`anyLast` are associative
//     and safe to apply at both levels.
//
//   - workspace_id first (D7/D11), through parameter binding, always. Nothing
//     in this file interpolates a customer's string into SQL.
//
// The one thing this leg does that the chart does not: it distinguishes an
// empty window from a measured zero (D13). An aggregate with no GROUP BY over
// zero rows returns ONE row of zeros, so `series_count` rides along and every
// caller gates on it — without that, a rule watching for a value below a
// threshold would fire on every minute the workspace was silent.

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// metricRow is the one row the metric leg's SQL returns.
type metricRow struct {
	SumDelta    float64   `ch:"sum_delta"`
	GaugeMin    float64   `ch:"gauge_min"`
	GaugeMax    float64   `ch:"gauge_max"`
	GaugeAvg    float64   `ch:"gauge_avg"`
	GaugeLast   float64   `ch:"gauge_last"`
	Bounds      []float64 `ch:"bounds"`
	HistCounts  []float64 `ch:"hist_counts"`
	HSum        float64   `ch:"h_sum"`
	HCount      float64   `ch:"h_count"`
	Unit        string    `ch:"unit"`
	SeriesCount uint64    `ch:"series_count"`
}

// metricSQL builds the read for one condition. `filterCount` is the only thing
// that varies the text; every value — the metric name, the type, the window,
// every filter key AND value — is bound, never spliced.
func metricSQL(filterCount int) string {
	var filters strings.Builder
	for i := 0; i < filterCount; i++ {
		// The attribute map is `anyLast`-merged per series and constant per
		// series_hash by construction (0005's own comment), so filtering it in
		// the inner WHERE — before any merge — is exact, and is what metrics.ts
		// does for the same reason.
		filters.WriteString("\n          AND attributes[?] = ?")
	}
	return `
SELECT
    sum(sum_delta)                                                  AS sum_delta,
    min(gauge_min)                                                  AS gauge_min,
    max(gauge_max)                                                  AS gauge_max,
    avgMerge(gauge_avg_state)                                       AS gauge_avg,
    argMaxMerge(gauge_last_state)                                   AS gauge_last,
    anyLast(bounds)                                                 AS bounds,
    arrayMap(x -> toFloat64(x), sumForEachMerge(hist_counts_state)) AS hist_counts,
    sum(h_sum)                                                      AS h_sum,
    toFloat64(sum(h_count))                                         AS h_count,
    anyLast(unit)                                                   AS unit,
    count()                                                         AS series_count
FROM (
    SELECT
        series_hash,
        anyLast(toString(unit))           AS unit,
        sum(sum_delta)                    AS sum_delta,
        min(gauge_min)                    AS gauge_min,
        max(gauge_max)                    AS gauge_max,
        avgMergeState(gauge_avg)          AS gauge_avg_state,
        argMaxMergeState(gauge_last)      AS gauge_last_state,
        anyLast(bounds)                   AS bounds,
        sumForEachMergeState(hist_counts) AS hist_counts_state,
        sum(h_sum)                        AS h_sum,
        sum(h_count)                      AS h_count
    FROM obstack.metric_points_1m
    WHERE workspace_id = ?
      AND name = ?
      AND type = ?
      AND bucket >= toStartOfMinute(now() - toIntervalSecond(?))` + filters.String() + `
    GROUP BY series_hash
)`
}

// evalMetric runs the metric leg and reduces the row to one observed value per
// the condition's (type, agg) — the same mapping metrics.ts's `pointValue`
// applies to a chart point.
func (e *Evaluator) evalMetric(ctx context.Context, workspaceID string, c Condition) (observation, error) {
	window, err := windowSeconds(c.Window)
	if err != nil {
		return observation{}, err
	}

	// Sorted so the same condition always produces the same statement text,
	// whatever order the JSONB document happened to store its keys in.
	keys := make([]string, 0, len(c.Filters))
	for k := range c.Filters {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	args := []any{workspaceID, c.Metric, c.Type, window}
	for _, k := range keys {
		args = append(args, k, c.Filters[k])
	}

	var row metricRow
	if err := e.conn.QueryRow(ctx, metricSQL(len(keys)), args...).ScanStruct(&row); err != nil {
		return observation{}, fmt.Errorf("evaluate metric %q: %w", c.Metric, err)
	}

	// No series matched at all: the window is empty, which is not a zero.
	if row.SeriesCount == 0 {
		return observation{unit: row.Unit}, nil
	}

	value, ok := metricValue(c, row, float64(window))
	return observation{value: value, unit: row.Unit, hasData: ok}, nil
}

// metricValue is the (type, agg) -> number mapping, mirroring metrics.ts's
// `pointValue`. `ok` is false where that function returns null: a histogram
// carrying no samples has no average and no quantile, and neither is zero.
func metricValue(c Condition, row metricRow, windowSecs float64) (float64, bool) {
	switch c.Type {
	case "gauge":
		switch c.Agg {
		case "avg":
			return row.GaugeAvg, true
		case "min":
			return row.GaugeMin, true
		case "max":
			return row.GaugeMax, true
		case "last":
			return row.GaugeLast, true
		}
	case "sum":
		switch c.Agg {
		case "sum":
			return row.SumDelta, true
		case "rate":
			// The packet's rate definition — sum_delta over the bucket's
			// seconds — with the ALERT WINDOW as the bucket: a per-second rate
			// over exactly the window the rule names. metrics.ts divides by its
			// chart bucket for the same reason.
			if windowSecs <= 0 {
				return 0, false
			}
			return row.SumDelta / windowSecs, true
		}
	case "histogram":
		switch c.Agg {
		case "avg":
			if row.HCount <= 0 {
				return 0, false
			}
			return row.HSum / row.HCount, true
		case "p50":
			return histogramQuantile(row.Bounds, row.HistCounts, 0.5)
		case "p90":
			return histogramQuantile(row.Bounds, row.HistCounts, 0.9)
		case "p95":
			return histogramQuantile(row.Bounds, row.HistCounts, 0.95)
		case "p99":
			return histogramQuantile(row.Bounds, row.HistCounts, 0.99)
		}
	}
	// Unreachable: ParseCondition validates agg against type from the same
	// table the web tier enforces (D390). A false rather than a panic keeps
	// D480's posture — an unevaluatable rule is not a firing rule.
	return 0, false
}

// histogramQuantile is a PORT of metrics.ts's function of the same name:
// linear interpolation over an OTel explicit-bounds histogram, where bounds[i]
// are the upper edges of the finite buckets and counts has one more element
// than bounds (the two open-ended edge buckets at either end).
//
// Nothing makes the Go and TS halves agree by construction, so what holds them
// together is evaluator_test.go's copy of metrics.test.ts's own fixtures —
// change the interpolation on either side and one of the two suites goes red.
//
// Returns ok=false where the TS half returns null: no samples at all, and an
// unbounded edge bucket with no finite edge to report. Both are gaps, and a gap
// is never a zero (D13) — an alert on a fabricated 0 would fire on silence.
func histogramQuantile(bounds, counts []float64, q float64) (float64, bool) {
	// An explicit-bounds histogram has exactly one more bucket than it has
	// edges. Anything else did not come from the shape this interpolates over,
	// and is a gap rather than a number read out of the wrong index.
	if len(counts) == 0 || len(bounds) != len(counts)-1 {
		return 0, false
	}

	total := 0.0
	for _, c := range counts {
		total += c
	}
	if total <= 0 {
		return 0, false
	}

	target := q * total
	cumulative := 0.0
	for i, count := range counts {
		next := cumulative + count
		if target > next {
			cumulative = next
			continue
		}
		hasLower, hasUpper := i > 0, i < len(counts)-1
		switch {
		case !hasLower && !hasUpper:
			// One open bucket with no edge at either end (legal OTLP): there
			// is no number to report.
			return 0, false
		case !hasLower:
			// Mass below the first finite bound: report the nearest KNOWN
			// boundary rather than extrapolating past it.
			return bounds[i], true
		case !hasUpper:
			return bounds[i-1], true
		}
		lower, upper := bounds[i-1], bounds[i]
		fraction := 0.0
		if count > 0 {
			fraction = (target - cumulative) / count
		}
		return lower + fraction*(upper-lower), true
	}
	// Unreachable while total > 0: cumulative reaches total by the last
	// bucket and target <= total by construction.
	return 0, false
}
