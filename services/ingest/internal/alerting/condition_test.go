package alerting

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

// D483: this file and apps/web/src/lib/alert-types.test.ts read the SAME
// fixture file and assert the same verdicts. Neither side restates the cases —
// that is the whole point: a rule that drifts in one language is a case the
// other language now decides differently, and the file makes that visible.
//
// Run with: go test ./internal/alerting/ -count=1

type conditionFixture struct {
	Name string `json:"name"`
	// Kept as raw bytes so the parser sees exactly what Postgres would hand it,
	// including numbers Go's float64 cannot hold (1e999) — decoding those into a
	// typed field here would move the rejection out of the code under test.
	Condition json.RawMessage `json:"condition"`
	Valid     bool            `json:"valid"`
}

const fixturePath = "testdata/condition-fixtures.json"

func loadConditionFixtures(t *testing.T) []conditionFixture {
	t.Helper()
	body, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("reading %s: %v", fixturePath, err)
	}
	var fixtures []conditionFixture
	if err := json.Unmarshal(body, &fixtures); err != nil {
		t.Fatalf("parsing %s: %v", fixturePath, err)
	}
	return fixtures
}

// The fixture file is only a proof while it still says something. A truncated or
// half-deleted file would let every parity assertion below pass by never running,
// so the shape of the corpus is asserted first — the same guard the TypeScript
// half applies, with the same numbers.
func TestConditionFixtureCorpusIsSubstantial(t *testing.T) {
	fixtures := loadConditionFixtures(t)
	valid, invalid := 0, 0
	seen := map[string]bool{}
	for _, f := range fixtures {
		if f.Name == "" {
			t.Fatalf("a fixture has no name")
		}
		if seen[f.Name] {
			t.Fatalf("duplicate fixture name %q — names identify a case in both languages' failure output", f.Name)
		}
		seen[f.Name] = true
		if f.Valid {
			valid++
		} else {
			invalid++
		}
	}
	if len(fixtures) < 20 {
		t.Fatalf("the fixture corpus shrank to %d cases; D483 wants the schema's whole surface covered", len(fixtures))
	}
	if valid < 8 || invalid < 8 {
		t.Fatalf("corpus is lopsided: %d valid, %d invalid — both verdicts must be exercised", valid, invalid)
	}
	t.Logf("%d fixtures: %d valid, %d invalid", len(fixtures), valid, invalid)
}

func TestConditionFixtureParity(t *testing.T) {
	for _, f := range loadConditionFixtures(t) {
		t.Run(f.Name, func(t *testing.T) {
			c, err := ParseCondition(f.Condition)
			if f.Valid {
				if err != nil {
					t.Fatalf("fixture is marked valid but Go rejected it: %v\n  condition: %s", err, f.Condition)
				}
				if c.Source != SourceMetric && c.Source != SourceTrace {
					t.Fatalf("parsed condition has no source: %+v", c)
				}
				return
			}
			if err == nil {
				t.Fatalf("fixture is marked invalid but Go accepted it: %+v\n  condition: %s", c, f.Condition)
			}
			// D480: a bad condition is an eval failure the caller can recognise,
			// never a bare error and never a panic.
			if !errors.Is(err, ErrInvalidCondition) {
				t.Fatalf("rejection does not wrap ErrInvalidCondition: %v", err)
			}
		})
	}
}

// Accepting a document is only half the contract; the evaluator reads the parsed
// fields, so the mapping from JSON to Condition is pinned here.
func TestParseConditionPopulatesTheNamedVariantOnly(t *testing.T) {
	metric, err := ParseCondition([]byte(`{"source":"metric","metric":"http.requests","type":"sum","agg":"rate","window":"5m","op":">","threshold":100,"filters":{"service.name":"checkout"}}`))
	if err != nil {
		t.Fatalf("valid metric condition rejected: %v", err)
	}
	if metric.Metric != "http.requests" || metric.Type != "sum" || metric.Agg != "rate" {
		t.Fatalf("metric leg mis-parsed: %+v", metric)
	}
	if metric.Window != "5m" || metric.Op != ">" || metric.Threshold != 100 {
		t.Fatalf("shared fields mis-parsed: %+v", metric)
	}
	if metric.Filters["service.name"] != "checkout" || len(metric.Filters) != 1 {
		t.Fatalf("filters mis-parsed: %+v", metric.Filters)
	}
	if metric.Signal != "" || metric.Service != nil {
		t.Fatalf("a metric condition carries trace-leg fields: %+v", metric)
	}

	scoped, err := ParseCondition([]byte(`{"source":"trace","signal":"p95_ms","service":"checkout","window":"1h","op":">","threshold":900}`))
	if err != nil {
		t.Fatalf("valid trace condition rejected: %v", err)
	}
	if scoped.Service == nil || *scoped.Service != "checkout" {
		t.Fatalf("service mis-parsed: %+v", scoped)
	}
	if scoped.Metric != "" || scoped.Agg != "" || scoped.Filters != nil {
		t.Fatalf("a trace condition carries metric-leg fields: %+v", scoped)
	}

	all, err := ParseCondition([]byte(`{"source":"trace","signal":"error_rate_pct","service":null,"window":"30m","op":">","threshold":2.5}`))
	if err != nil {
		t.Fatalf("valid all-services trace condition rejected: %v", err)
	}
	// null and absent are different documents (see rawCondition): null means
	// every service, absent is a malformed condition.
	if all.Service != nil {
		t.Fatalf("service:null must parse to nil (all services), got %q", *all.Service)
	}
	if _, err := ParseCondition([]byte(`{"source":"trace","signal":"error_rate_pct","window":"30m","op":">","threshold":2.5}`)); err == nil {
		t.Fatalf("an absent service key must be rejected — it is not the same document as service:null")
	}
}

// The agg-validity table is a MIRROR of lib/metrics-types.ts's VALID_AGGS
// (D390). The fixture file proves the pairings it names; this proves the mirror
// has no extra pairing the fixtures happen not to mention.
func TestValidAggsMirrorsTheContractTable(t *testing.T) {
	want := map[string]string{
		"gauge":     "avg,min,max,last",
		"sum":       "sum,rate",
		"histogram": "p50,p90,p95,p99,avg",
	}
	if len(validAggs) != len(want) {
		t.Fatalf("the metric type vocabulary changed: %v", validAggs)
	}
	for typ, aggs := range want {
		got := strings.Join(validAggs[typ], ",")
		if got != aggs {
			t.Fatalf("validAggs[%q] = %q, contract says %q — lib/metrics-types.ts's VALID_AGGS is the authority", typ, got, aggs)
		}
	}
}

// D480: the caller advances next_eval_at and counts the failure. It never gets a
// panic, whatever the column held.
func TestParseConditionNeverPanics(t *testing.T) {
	for _, junk := range []string{"", "{", "}{", "[[[", "\x00\x01", `{"source":"metric"`, "null", "true", "1e999"} {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("ParseCondition panicked on %q: %v", junk, r)
				}
			}()
			if _, err := ParseCondition([]byte(junk)); err == nil {
				t.Fatalf("ParseCondition accepted junk %q", junk)
			} else if !errors.Is(err, ErrInvalidCondition) {
				t.Fatalf("junk %q produced an unrecognisable error: %v", junk, err)
			}
		}()
	}
}
