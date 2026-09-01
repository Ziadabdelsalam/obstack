// Package alerting holds the alert condition schema — the Go half of the D483
// cross-language contract — and (S7.1 T4) the evaluator that runs it.
//
// The schema exists twice by necessity: the web app validates a condition on
// write, in TypeScript, so that a rule this evaluator cannot parse is never
// written at all; this package re-validates on claim, because a row in Postgres
// can predate any schema change. `apps/web/src/lib/alert-types.ts` is the other
// half. Nothing in either language makes the two agree by construction, so what
// freezes them together is `testdata/condition-fixtures.json`: one fixture file
// of valid and invalid conditions that BOTH sides must accept and reject
// identically (D483, the D385 precedent). Change a rule in one language and the
// parity test in the other goes red.
//
// A failed parse is an EVAL FAILURE, never a crash (D480): ParseCondition
// returns an error wrapping ErrInvalidCondition, the caller leaves the rule's
// state unchanged, advances next_eval_at and counts it — a rule that cannot be
// evaluated is not a firing rule.
package alerting

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
)

// ErrInvalidCondition is what every rejection wraps. Callers test with
// errors.Is and treat it as the D480 fail-open path; the wrapped detail is for
// the ops log and the web-side refusal sentence, never for a decision.
var ErrInvalidCondition = errors.New("invalid alert condition")

// The two condition sources (D481). `metric` aggregates a metric over a window;
// `trace` computes one of two signals over trace_summaries.
const (
	SourceMetric = "metric"
	SourceTrace  = "trace"
)

// validAggs is the D390 agg-validity table restated in Go.
//
// `apps/web/src/lib/metrics-types.ts`'s VALID_AGGS is the AUTHORITY — it is the
// one table the product enforces, and the query layer, the explore page and the
// dashboards editor all read it there. This map is a MIRROR, unavoidable because
// Go cannot import TypeScript. What keeps a mirror honest is not a comment but a
// test: every agg/type pairing in testdata/condition-fixtures.json is decided by
// both tables, so a drift on either side turns that file's verdicts red.
var validAggs = map[string][]string{
	"gauge":     {"avg", "min", "max", "last"},
	"sum":       {"sum", "rate"},
	"histogram": {"p50", "p90", "p95", "p99", "avg"},
}

// The D482 alert-lookback vocabulary. Deliberately NOT MetricRange (1h/6h/24h),
// which is a chart width — see alert-types.ts's AlertWindow for the reasoning.
var alertWindows = []string{"5m", "15m", "30m", "1h"}

var alertOps = []string{">", "<"}

var traceSignals = []string{"error_rate_pct", "p95_ms"}

// Condition is one parsed alert condition — the union of D481's two shapes,
// flattened, with `Source` as the discriminator. Only the fields belonging to
// the named source are populated; ParseCondition rejects a document that carries
// the other variant's keys, so a `metric` Condition never has a Signal and a
// `trace` Condition never has Filters.
//
// This is a PARSE target. The web app writes alert_rules.condition; nothing in
// Go re-marshals a Condition back to JSONB, so the tags below document the wire
// shape rather than promising a byte-exact round trip.
type Condition struct {
	Source string `json:"source"`

	// The metric leg (Source == SourceMetric).
	Metric  string            `json:"metric,omitempty"`
	Type    string            `json:"type,omitempty"`
	Agg     string            `json:"agg,omitempty"`
	Filters map[string]string `json:"filters,omitempty"`

	// The trace leg (Source == SourceTrace). Service nil = every service.
	Signal  string  `json:"signal,omitempty"`
	Service *string `json:"service,omitempty"`

	// Both legs.
	Window    string  `json:"window"`
	Op        string  `json:"op"`
	Threshold float64 `json:"threshold"`
}

// rawCondition is the decode target, carrying BOTH variants' keys so that
// json.Decoder.DisallowUnknownFields can reject a genuinely unknown key while
// this package rejects a known-but-foreign one with a message that says which
// variant it belongs to.
//
// Presence semantics, which is the whole reason for the pointers: a nil pointer
// means the key was absent OR explicitly null, and both are rejected for every
// field that uses one — null is not a legal value for any of them. `Service` is
// the ONE field where null IS legal (it means "all services") and absence is
// not, so it decodes as json.RawMessage: nil = the key was absent, "null" = the
// key was present and null. The TypeScript half draws the same distinction with
// Object.hasOwn, and the fixture file pins both cases.
type rawCondition struct {
	Source    *string            `json:"source"`
	Metric    *string            `json:"metric"`
	Type      *string            `json:"type"`
	Agg       *string            `json:"agg"`
	Filters   *map[string]string `json:"filters"`
	Signal    *string            `json:"signal"`
	Service   json.RawMessage    `json:"service"`
	Window    *string            `json:"window"`
	Op        *string            `json:"op"`
	Threshold *float64           `json:"threshold"`
}

func invalidf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidCondition, fmt.Sprintf(format, args...))
}

// ParseCondition decodes and validates one alert_rules.condition document.
//
// Strict by the same rules the TypeScript half applies: unknown keys rejected,
// every key of the named variant required, no key of the other variant, window
// and op and signal from their closed vocabularies, agg valid for type per
// validAggs, threshold a finite number, metric and service names non-empty,
// filter values strings. Every rejection wraps ErrInvalidCondition.
func ParseCondition(data []byte) (Condition, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()

	var raw rawCondition
	if err := dec.Decode(&raw); err != nil {
		return Condition{}, invalidf("%s", err)
	}
	// A condition is exactly one JSON value; anything after it is not this
	// document. (json.Unmarshal would reject it; the streaming decoder will not.)
	if err := dec.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return Condition{}, invalidf("trailing content after the condition object")
	}

	if raw.Source == nil {
		return Condition{}, invalidf("source must be %q or %q", SourceMetric, SourceTrace)
	}
	source := *raw.Source
	if source != SourceMetric && source != SourceTrace {
		return Condition{}, invalidf("source must be %q or %q", SourceMetric, SourceTrace)
	}

	// Shared vocabulary, checked once for both variants.
	window, err := requireOneOf(raw.Window, "window", alertWindows)
	if err != nil {
		return Condition{}, err
	}
	op, err := requireOneOf(raw.Op, "op", alertOps)
	if err != nil {
		return Condition{}, err
	}
	if raw.Threshold == nil {
		return Condition{}, invalidf("threshold must be a finite number")
	}
	threshold := *raw.Threshold
	if math.IsNaN(threshold) || math.IsInf(threshold, 0) {
		return Condition{}, invalidf("threshold must be a finite number")
	}

	c := Condition{Source: source, Window: window, Op: op, Threshold: threshold}

	if source == SourceTrace {
		if err := forbid(map[string]bool{
			"metric":  raw.Metric != nil,
			"type":    raw.Type != nil,
			"agg":     raw.Agg != nil,
			"filters": raw.Filters != nil,
		}, SourceTrace); err != nil {
			return Condition{}, err
		}
		signal, err := requireOneOf(raw.Signal, "signal", traceSignals)
		if err != nil {
			return Condition{}, err
		}
		c.Signal = signal
		if raw.Service == nil {
			return Condition{}, invalidf("missing key service for a trace condition")
		}
		if !bytes.Equal(bytes.TrimSpace(raw.Service), []byte("null")) {
			var service string
			if err := json.Unmarshal(raw.Service, &service); err != nil {
				return Condition{}, invalidf("service must be a string or null")
			}
			if strings.TrimSpace(service) == "" {
				return Condition{}, invalidf("service must not be empty")
			}
			c.Service = &service
		}
		return c, nil
	}

	if err := forbid(map[string]bool{
		"signal":  raw.Signal != nil,
		"service": raw.Service != nil,
	}, SourceMetric); err != nil {
		return Condition{}, err
	}
	if raw.Metric == nil || strings.TrimSpace(*raw.Metric) == "" {
		return Condition{}, invalidf("metric must be a non-empty string")
	}
	c.Metric = *raw.Metric
	if raw.Type == nil {
		return Condition{}, invalidf("missing key type for a metric condition")
	}
	aggs, ok := validAggs[*raw.Type]
	if !ok {
		return Condition{}, invalidf("type must be one of gauge, sum, histogram")
	}
	c.Type = *raw.Type
	agg, err := requireOneOf(raw.Agg, "agg", aggs)
	if err != nil {
		return Condition{}, invalidf("agg must be one of %s for a %s metric", strings.Join(aggs, ", "), c.Type)
	}
	c.Agg = agg
	if raw.Filters == nil {
		return Condition{}, invalidf("filters must be an object")
	}
	// A non-string filter value never reaches here: the decode into
	// map[string]string above already refused it, which is the same verdict the
	// TypeScript half reaches by inspecting the parsed values.
	c.Filters = *raw.Filters
	if c.Filters == nil {
		c.Filters = map[string]string{}
	}
	return c, nil
}

// requireOneOf demands a present key whose value is in a closed vocabulary.
func requireOneOf(value *string, field string, allowed []string) (string, error) {
	if value == nil {
		return "", invalidf("%s must be one of %s", field, strings.Join(allowed, ", "))
	}
	for _, a := range allowed {
		if *value == a {
			return a, nil
		}
	}
	return "", invalidf("%s must be one of %s", field, strings.Join(allowed, ", "))
}

// forbid rejects a key that belongs to the OTHER variant. DisallowUnknownFields
// cannot catch these — they are known fields of rawCondition — so the exact key
// set of each variant is enforced here, matching the TypeScript half's key-set
// check exactly.
func forbid(present map[string]bool, source string) error {
	for _, key := range []string{"metric", "type", "agg", "filters", "signal", "service"} {
		if present[key] {
			return invalidf("unknown key %s for a %s condition", key, source)
		}
	}
	return nil
}
