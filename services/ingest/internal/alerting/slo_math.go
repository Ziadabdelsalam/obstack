package alerting

// slo_math.go — D509, the one definition of attainment, budget and status.
//
// The TypeScript half (`sloBudget` in apps/web/src/lib/slo-types.ts) is a
// MIRROR for the editor's preview and nothing else: the evaluator is the
// writer of every number the card renders. The fixture file's `arithmetic`
// section pins the two against each other case by case.
//
// Everything is decided on COUNTS in integer arithmetic, not on a rendered
// percentage. A target has at most three decimals (NUMERIC(6,3)), so the
// budget test `bad/total > (100-target)/100` becomes
//
//	bad × 100000 > total × (100000 − target×1000)
//
// with no floating point on the side that decides. The alternative — comparing
// a float ratio to a float threshold — puts 997 good of 1000 at a 99.7% target
// one ulp over its own budget, and a customer's objective must not breach on a
// rounding error (the fixture's "float-trap" cases).

import "math"

// AtRiskBudgetPct is where a healthy objective becomes an at-risk one: the
// share of the error budget consumed. The mock page's own colour threshold,
// one constant; pre-registered as a per-SLO option (packet D509).
const AtRiskBudgetPct = 75.0

// The D508/D509 status vocabulary as constants, matching the DDL's CHECK.
const (
	statusHealthy  = "healthy"
	statusAtRisk   = "at-risk"
	statusBreached = "breached"
	statusNoData   = "no-data"
)

// sloMeasurement is one evaluation's outcome. hasData is false for an empty
// window, in which case the numbers are unset and the status is no-data —
// callers branch on it before reading current or burned (the observation
// rule).
type sloMeasurement struct {
	good    int64
	total   int64
	current float64 // attainment, percent
	burned  float64 // error budget consumed, percent — unbounded above
	status  string
	hasData bool
}

// targetMilli is the target in thousandths of a percent, the integer the
// budget test is decided in.
func targetMilli(target float64) int64 {
	return int64(math.Round(target * 1000))
}

// sloMeasure reduces (good, total, target) to a measurement.
func sloMeasure(good, total int64, target float64) sloMeasurement {
	if total <= 0 {
		return sloMeasurement{status: statusNoData}
	}
	if good < 0 {
		good = 0
	}
	if good > total {
		good = total
	}
	bad := total - good
	// allowedMilli is the budget as (total × thousandths-of-a-percent): the
	// denominator both the breach test and the burned ratio share.
	allowedMilli := total * (100000 - targetMilli(target))

	m := sloMeasurement{good: good, total: total, hasData: true}
	m.current = float64(good) * 100 / float64(total)
	// bad×100000 / allowedMilli is the fraction of the budget consumed;
	// ×100 makes it a percentage.
	m.burned = float64(bad) * 100000 * 100 / float64(allowedMilli)

	switch {
	case bad*100000 > allowedMilli:
		m.status = statusBreached
	case m.burned >= AtRiskBudgetPct:
		m.status = statusAtRisk
	default:
		m.status = statusHealthy
	}
	return m
}
