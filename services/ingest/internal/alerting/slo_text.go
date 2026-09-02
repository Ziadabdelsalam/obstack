package alerting

// slo_text.go — what an SLO transition event SAYS, and the objective sentence
// the webhook payload carries.
//
// The same seam event_text.go states, restated for a second surface: the
// product's objective sentence is rendered by ONE TypeScript formatter
// (`formatSloObjective`, packet §0) for the card. This file composes a title
// and a detail for the feed and the webhook from the parsed fields — a
// different artifact for a different reader. `sloObjective` below is a Go
// restatement of the same structured fields for `slo.objective` in the
// payload (D512); it is deliberately built the same way so the two read the
// same, but nothing makes them byte-identical and nothing depends on it.

import (
	"fmt"
	"strconv"
	"strings"
)

// sloObjective renders "<target>% of traces <good-definition> over <window> ·
// <scope>" from the structured fields.
func sloObjective(ind Indicator, target float64, window string) string {
	scope := "all services"
	if ind.Service != nil {
		scope = "service " + *ind.Service
	}
	good := "without an error span"
	if ind.Kind == KindLatency {
		good = fmt.Sprintf("under %d ms", ind.ThresholdMs)
	}
	return fmt.Sprintf("%s%% of traces %s over %s · %s", formatTarget(target), good, window, scope)
}

// formatTarget prints a target as its author typed it: trailing zeros
// trimmed, never scientific.
func formatTarget(target float64) string {
	return strconv.FormatFloat(target, 'f', -1, 64)
}

// sloTransitionText composes the event for a status change INTO `to`.
//
//	breached:  "<name>: breached — 98.4% against a 99% target"
//	at-risk:   "<name>: at risk — 80% of the error budget consumed"
//	healthy:   "<name>: healthy again — 99.3% against a 99% target"
//	detail:    "<objective>: 98.4% over the last 30d (984 of 1,000 traces
//	            good); 160% of the error budget consumed."
func sloTransitionText(name string, ind Indicator, target float64, window string, m sloMeasurement, to string) (title, detail string) {
	current := formatNumber(m.current) + "%"
	burned := formatNumber(m.burned) + "%"
	switch to {
	case statusBreached:
		title = fmt.Sprintf("%s: breached — %s against a %s%% target", name, current, formatTarget(target))
	case statusAtRisk:
		title = fmt.Sprintf("%s: at risk — %s of the error budget consumed", name, burned)
	default:
		title = fmt.Sprintf("%s: healthy again — %s against a %s%% target", name, current, formatTarget(target))
	}
	detail = fmt.Sprintf("%s: %s over the last %s (%s of %s traces good); %s of the error budget consumed.",
		sloObjective(ind, target, window), current, window,
		groupThousands(m.good), groupThousands(m.total), burned)
	return title, detail
}

// groupThousands renders 1234567 as 1,234,567.
func groupThousands(n int64) string {
	s := strconv.FormatInt(n, 10)
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	head := len(s) % 3
	if head > 0 {
		b.WriteString(s[:head])
	}
	for i := head; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s[i : i+3])
	}
	return b.String()
}
