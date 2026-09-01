package alerting

// event_text.go — what an alert event SAYS, composed from the condition's
// structured fields and the value actually observed.
//
// The one rule this file obeys, ruled at T2 and restated here because it is the
// thing a future edit is most likely to undo: there is no Go clone of the
// product's condition formatter. `apps/web/src/lib/alert-types.ts`'s
// `formatAlertCondition` is the ONE renderer of a condition string, it renders
// for the rules list and the events feed, and nothing here tries to reproduce
// its output. What this file composes instead is a title and a SENTENCE, built
// from the parsed fields — a different artifact for a different reader, so a
// change to either one can never make the two disagree about a rule (they were
// never claiming to say the same thing).
//
// One seam is stated rather than smoothed: `notify.RulePayload.Condition` is
// documented in T3's package as "the human-readable rendering ... produced by
// the one shared formatter (D481)". That formatter is TypeScript and this
// process is Go, so the webhook payload carries `conditionSummary` below — a
// factual restatement of the same structured fields, deliberately NOT
// byte-identical to what the product renders. Escalated in the T4 report; the
// alternative (an empty `condition` in every payload) loses more than it saves.

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// firingText composes the `ok -> firing` event.
//
//	title:  "p95 checkout: 9214ms > 8000ms"
//	detail: "p95_ms for service checkout over the last 15m measured 9214ms
//	         against a threshold of 8000ms."
//
// The threshold is rendered in the OBSERVED value's unit, because that is the
// unit the comparison happened in — a threshold of 8000 against a metric
// reported in milliseconds is 8000 milliseconds, and printing it bare would
// invite the reader to supply their own unit.
func firingText(ruleName string, c Condition, obs observation) (title, detail string) {
	title = fmt.Sprintf("%s: %s %s %s",
		ruleName,
		formatObserved(obs.value, obs.unit),
		c.Op,
		formatObserved(c.Threshold, obs.unit))
	detail = fmt.Sprintf("%s measured %s against a threshold of %s.",
		conditionScope(c),
		formatObserved(obs.value, obs.unit),
		formatObserved(c.Threshold, obs.unit))
	return title, detail
}

// resolutionText composes the `firing -> ok` event (D484). Its title says the
// one thing the reader of a resolution needs — which rule stopped — and its
// detail says what the value is now.
func resolutionText(ruleName string, c Condition, obs observation) (title, detail string) {
	title = ruleName + ": resolved"
	detail = fmt.Sprintf("%s measured %s, back within the %s threshold.",
		conditionScope(c),
		formatObserved(obs.value, obs.unit),
		formatObserved(c.Threshold, obs.unit))
	return title, detail
}

// conditionScope names WHAT was measured, over what window, under what scope —
// the sentence fragment both event details are built on.
//
// Filters render sorted by key so the same condition always produces the same
// sentence regardless of the JSONB document's key order.
func conditionScope(c Condition) string {
	if c.Source == SourceTrace {
		scope := "across all services"
		if c.Service != nil {
			scope = "for service " + *c.Service
		}
		return fmt.Sprintf("%s %s over the last %s", c.Signal, scope, c.Window)
	}

	scope := fmt.Sprintf("%s (%s %s) over the last %s", c.Metric, c.Type, c.Agg, c.Window)
	if len(c.Filters) == 0 {
		return scope
	}
	keys := make([]string, 0, len(c.Filters))
	for k := range c.Filters {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, k := range keys {
		pairs = append(pairs, k+"="+c.Filters[k])
	}
	return scope + " filtered to " + strings.Join(pairs, ", ")
}

// conditionSummary is what a webhook receiver is told the rule watches for. See
// the file comment: it is a restatement, not the product's rendered string.
func conditionSummary(c Condition) string {
	direction := "above"
	if c.Op == "<" {
		direction = "below"
	}
	return fmt.Sprintf("%s, alerting when %s %s", conditionScope(c), direction, formatNumber(c.Threshold))
}

// formatObserved renders a number with its unit, for humans.
//
// OTLP's dimensionless unit is the string "1" (and an unset unit is empty);
// both render bare, because "0.93 1" is not a measurement anybody reads.
func formatObserved(value float64, unit string) string {
	return formatNumber(value) + unitSuffix(unit)
}

func unitSuffix(unit string) string {
	if unit == "" || unit == "1" {
		return ""
	}
	return unit
}

// formatNumber trades precision for legibility on a scale, because an alert
// title is read at 3am: past a hundred nobody wants the decimals, and below one
// the decimals are the whole number. Trailing zeros are trimmed so a round
// value renders round.
func formatNumber(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		// ParseCondition refuses a non-finite threshold and the legs gate on
		// hasData, so this is unreachable — and prints something honest rather
		// than "NaN%" if it ever is not.
		return "an unrepresentable value"
	}
	prec := 2
	switch abs := math.Abs(v); {
	case abs >= 100:
		prec = 0
	case abs >= 1:
		prec = 2
	default:
		prec = 4
	}
	s := strconv.FormatFloat(v, 'f', prec, 64)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(s, "0")
		s = strings.TrimSuffix(s, ".")
	}
	return s
}
