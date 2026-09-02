package alerting

// indicator.go — the SLO indicator schema, the Go half of the D517
// cross-language contract (the condition.go pattern for a second shape).
//
// `apps/web/src/lib/slo-types.ts` validates an indicator on write so that an
// SLO this evaluator cannot parse is never written; this file re-validates on
// claim, because a row in Postgres can predate any schema change. What freezes
// the two together is `testdata/indicator-fixtures.json`: one file of valid
// and invalid indicators (and D509 arithmetic cases) that BOTH sides must
// decide identically. Change a rule in one language and the other's parity
// test goes red.
//
// A failed parse is an EVAL FAILURE, never a crash (D480/D510): ParseIndicator
// returns an error wrapping ErrInvalidIndicator, the caller leaves the SLO's
// status and numbers unchanged, advances next_eval_at and counts it.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
)

// ErrInvalidIndicator is what every rejection wraps.
var ErrInvalidIndicator = errors.New("invalid slo indicator")

// The two indicator kinds (D505). `availability` counts traces with no error
// span as good; `latency` counts traces whose duration is at or under the
// threshold as good.
const (
	KindAvailability = "availability"
	KindLatency      = "latency"
)

// sloIndicatorKinds and sloWindows are the vocabularies as runtime lists — the
// TypeScript parity test reads these declarations from this file's source
// (the alert-types.test.ts idiom), so they stay `var name = []string{...}`.
var sloIndicatorKinds = []string{KindAvailability, KindLatency}

// The D507 window vocabulary: rolling days, stored on the slos row as
// eval_window. Deliberately not the alert lookback (D482) — an objective is
// measured over days, an alert over minutes.
var sloWindows = []string{"7d", "30d"}

// The D508/D509 status vocabulary, matching the DDL's CHECK.
var sloStatuses = []string{"healthy", "at-risk", "breached", "no-data"}

// Indicator is one parsed slos.indicator document. Only ThresholdMs belongs to
// the latency kind; ParseIndicator rejects it on an availability document, so
// an availability Indicator never carries one.
//
// A PARSE target, like Condition: the web app writes slos.indicator and nothing
// in Go re-marshals one.
type Indicator struct {
	Kind string `json:"kind"`
	// Service nil = every service (the trace leg's D481 scope, D506).
	Service *string `json:"service,omitempty"`
	// ThresholdMs is the latency kind's boundary: a trace is good when its
	// duration is <= this many milliseconds. Positive integer.
	ThresholdMs int64 `json:"thresholdMs,omitempty"`
}

// rawIndicator is the decode target. Presence semantics are the rawCondition
// ones: a nil pointer is absent-or-null and both are rejected for kind and
// thresholdMs; `service` is the one field where null IS legal (all services)
// and absence is not, so it decodes as json.RawMessage.
type rawIndicator struct {
	Kind        *string         `json:"kind"`
	Service     json.RawMessage `json:"service"`
	ThresholdMs *float64        `json:"thresholdMs"`
}

func invalidIndicatorf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidIndicator, fmt.Sprintf(format, args...))
}

// ParseIndicator decodes and validates one slos.indicator document.
//
// Strict by the same rules the TypeScript half applies: unknown keys rejected,
// kind from its closed vocabulary, `service` present (a string or null, a
// string non-blank), `thresholdMs` present on latency and ABSENT on
// availability, and when present a finite positive integer. Every rejection
// wraps ErrInvalidIndicator.
func ParseIndicator(data []byte) (Indicator, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()

	var raw rawIndicator
	if err := dec.Decode(&raw); err != nil {
		return Indicator{}, invalidIndicatorf("%s", err)
	}
	if err := dec.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return Indicator{}, invalidIndicatorf("trailing content after the indicator object")
	}

	kind, err := requireOneOf(raw.Kind, "kind", sloIndicatorKinds)
	if err != nil {
		return Indicator{}, invalidIndicatorf("kind must be one of %s", strings.Join(sloIndicatorKinds, ", "))
	}
	ind := Indicator{Kind: kind}

	if raw.Service == nil {
		return Indicator{}, invalidIndicatorf("missing key service for a %s indicator", kind)
	}
	if !bytes.Equal(bytes.TrimSpace(raw.Service), []byte("null")) {
		var service string
		if err := json.Unmarshal(raw.Service, &service); err != nil {
			return Indicator{}, invalidIndicatorf("service must be a string or null")
		}
		if strings.TrimSpace(service) == "" {
			return Indicator{}, invalidIndicatorf("service must not be empty")
		}
		ind.Service = &service
	}

	if kind == KindAvailability {
		if raw.ThresholdMs != nil {
			return Indicator{}, invalidIndicatorf("unknown key thresholdMs for an availability indicator")
		}
		return ind, nil
	}

	if raw.ThresholdMs == nil {
		return Indicator{}, invalidIndicatorf("thresholdMs must be a positive whole number of milliseconds")
	}
	t := *raw.ThresholdMs
	if math.IsNaN(t) || math.IsInf(t, 0) || t <= 0 || t != math.Trunc(t) || t > math.MaxInt32 {
		return Indicator{}, invalidIndicatorf("thresholdMs must be a positive whole number of milliseconds")
	}
	ind.ThresholdMs = int64(t)
	return ind, nil
}

// windowDays turns the D507 vocabulary into the number the read binds.
func windowDays(window string) (int, error) {
	switch window {
	case "7d":
		return 7, nil
	case "30d":
		return 30, nil
	default:
		return 0, fmt.Errorf("%w: window %q", ErrInvalidIndicator, window)
	}
}
