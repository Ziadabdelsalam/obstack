package alerting

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

// D517: this file and apps/web/src/lib/slo-types.test.ts read the SAME fixture
// file and assert the same verdicts (the condition_test.go shape for a second
// schema).
//
// Run with: go test ./internal/alerting/ -run 'Indicator|SloMeasure|SloText' -count=1

type indicatorFixture struct {
	Name      string          `json:"name"`
	Indicator json.RawMessage `json:"indicator"`
	Valid     bool            `json:"valid"`
}

type arithmeticFixture struct {
	Name            string   `json:"name"`
	Good            int64    `json:"good"`
	Total           int64    `json:"total"`
	Target          float64  `json:"target"`
	CurrentPct      *float64 `json:"currentPct"`
	BudgetBurnedPct *float64 `json:"budgetBurnedPct"`
	Status          string   `json:"status"`
}

type indicatorFixtureFile struct {
	Indicators []indicatorFixture  `json:"indicators"`
	Arithmetic []arithmeticFixture `json:"arithmetic"`
}

const indicatorFixturePath = "testdata/indicator-fixtures.json"

func loadIndicatorFixtures(t *testing.T) indicatorFixtureFile {
	t.Helper()
	body, err := os.ReadFile(indicatorFixturePath)
	if err != nil {
		t.Fatalf("reading %s: %v", indicatorFixturePath, err)
	}
	var f indicatorFixtureFile
	if err := json.Unmarshal(body, &f); err != nil {
		t.Fatalf("parsing %s: %v", indicatorFixturePath, err)
	}
	return f
}

// The corpus is only a proof while it still says something — the same shape
// guard as the condition corpus, with the same numbers on the TS side.
func TestIndicatorFixtureCorpusIsSubstantial(t *testing.T) {
	f := loadIndicatorFixtures(t)
	valid, invalid := 0, 0
	seen := map[string]bool{}
	for _, c := range f.Indicators {
		if c.Name == "" {
			t.Fatalf("an indicator fixture has no name")
		}
		if seen[c.Name] {
			t.Fatalf("duplicate fixture name %q", c.Name)
		}
		seen[c.Name] = true
		if c.Valid {
			valid++
		} else {
			invalid++
		}
	}
	if len(f.Indicators) < 20 {
		t.Fatalf("the indicator corpus shrank to %d cases", len(f.Indicators))
	}
	if valid < 8 || invalid < 8 {
		t.Fatalf("corpus is lopsided: %d valid, %d invalid", valid, invalid)
	}
	if len(f.Arithmetic) < 10 {
		t.Fatalf("the arithmetic corpus shrank to %d cases", len(f.Arithmetic))
	}
	t.Logf("%d indicators (%d valid, %d invalid), %d arithmetic cases", len(f.Indicators), valid, invalid, len(f.Arithmetic))
}

func TestIndicatorFixtureParity(t *testing.T) {
	for _, c := range loadIndicatorFixtures(t).Indicators {
		t.Run(c.Name, func(t *testing.T) {
			ind, err := ParseIndicator(c.Indicator)
			if c.Valid {
				if err != nil {
					t.Fatalf("fixture is marked valid but Go rejected it: %v\n  indicator: %s", err, c.Indicator)
				}
				if ind.Kind != KindAvailability && ind.Kind != KindLatency {
					t.Fatalf("parsed indicator has no kind: %+v", ind)
				}
				return
			}
			if err == nil {
				t.Fatalf("fixture is marked invalid but Go accepted it: %+v\n  indicator: %s", ind, c.Indicator)
			}
			if !errors.Is(err, ErrInvalidIndicator) {
				t.Fatalf("rejection does not wrap ErrInvalidIndicator: %v", err)
			}
		})
	}
}

func TestParseIndicatorPopulatesTheFields(t *testing.T) {
	lat, err := ParseIndicator([]byte(`{"kind":"latency","service":"checkout","thresholdMs":2000}`))
	if err != nil {
		t.Fatalf("valid latency indicator rejected: %v", err)
	}
	if lat.Kind != KindLatency || lat.Service == nil || *lat.Service != "checkout" || lat.ThresholdMs != 2000 {
		t.Fatalf("latency indicator mis-parsed: %+v", lat)
	}
	avail, err := ParseIndicator([]byte(`{"kind":"availability","service":null}`))
	if err != nil {
		t.Fatalf("valid availability indicator rejected: %v", err)
	}
	if avail.Service != nil || avail.ThresholdMs != 0 {
		t.Fatalf("availability indicator mis-parsed: %+v", avail)
	}
	if _, err := ParseIndicator([]byte(`{"kind":"availability"}`)); err == nil {
		t.Fatal("an absent service key must be rejected — it is not the same document as service:null")
	}
}

func TestParseIndicatorNeverPanics(t *testing.T) {
	for _, junk := range []string{"", "{", "}{", "[[[", "\x00\x01", `{"kind":"latency"`, "null", "true", "1e999", `{"kind":"latency","service":null,"thresholdMs":1e999}`} {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("ParseIndicator panicked on %q: %v", junk, r)
				}
			}()
			if _, err := ParseIndicator([]byte(junk)); err == nil {
				t.Fatalf("ParseIndicator accepted junk %q", junk)
			} else if !errors.Is(err, ErrInvalidIndicator) {
				t.Fatalf("junk %q produced an unrecognisable error: %v", junk, err)
			}
		}()
	}
}

func TestWindowDaysReadsTheVocabulary(t *testing.T) {
	for _, w := range sloWindows {
		if _, err := windowDays(w); err != nil {
			t.Errorf("windowDays(%q) rejected a vocabulary entry: %v", w, err)
		}
	}
	if _, err := windowDays("1d"); err == nil {
		t.Error("windowDays accepted 1d, which is not in the vocabulary")
	}
}

// ---- D509: the arithmetic, pinned to the shared fixture and to the packet's table ----

func TestSloMeasureMatchesTheFixtureCases(t *testing.T) {
	for _, c := range loadIndicatorFixtures(t).Arithmetic {
		t.Run(c.Name, func(t *testing.T) {
			m := sloMeasure(c.Good, c.Total, c.Target)
			if m.status != c.Status {
				t.Fatalf("status = %q, want %q (good %d, total %d, target %v)", m.status, c.Status, c.Good, c.Total, c.Target)
			}
			if c.CurrentPct == nil {
				if m.hasData {
					t.Fatalf("hasData = true on a no-data case")
				}
				return
			}
			if !m.hasData {
				t.Fatalf("hasData = false on a measured case")
			}
			if m.current != *c.CurrentPct {
				t.Errorf("current = %v, want %v", m.current, *c.CurrentPct)
			}
			if m.burned != *c.BudgetBurnedPct {
				t.Errorf("burned = %v, want %v", m.burned, *c.BudgetBurnedPct)
			}
		})
	}
}

// The strict boundary is decided on counts: a rendered ratio one ulp over its
// budget must not breach.
func TestSloMeasureDecidesTheBoundaryOnCounts(t *testing.T) {
	for _, tc := range []struct {
		good, total int64
		target      float64
		want        string
	}{
		{997, 1000, 99.7, statusAtRisk},
		{996, 1000, 99.7, statusBreached},
		{9997, 10000, 99.97, statusAtRisk},
		{9996, 10000, 99.97, statusBreached},
		{99997, 100000, 99.997, statusAtRisk},
		{99996, 100000, 99.997, statusBreached},
	} {
		if got := sloMeasure(tc.good, tc.total, tc.target).status; got != tc.want {
			t.Errorf("sloMeasure(%d, %d, %v).status = %q, want %q", tc.good, tc.total, tc.target, got, tc.want)
		}
	}
}

func TestSloMeasureClampsImpossibleCounts(t *testing.T) {
	if m := sloMeasure(12, 10, 99); m.current != 100 || m.status != statusHealthy {
		t.Errorf("good > total should clamp to 100%%: %+v", m)
	}
	if m := sloMeasure(-1, 10, 50); m.current != 0 || m.status != statusBreached {
		t.Errorf("good < 0 should clamp to 0%%: %+v", m)
	}
}

// ---- the text ----

func TestSloTransitionTextComposesFromStructuredFields(t *testing.T) {
	svc := "checkout"
	avail := Indicator{Kind: KindAvailability, Service: &svc}
	lat := Indicator{Kind: KindLatency, Service: nil, ThresholdMs: 2000}

	if got := sloObjective(avail, 99.9, "30d"); got != "99.9% of traces without an error span over 30d · service checkout" {
		t.Errorf("availability objective = %q", got)
	}
	if got := sloObjective(lat, 99, "7d"); got != "99% of traces under 2000 ms over 7d · all services" {
		t.Errorf("latency objective = %q", got)
	}
	if got := sloObjective(lat, 99.999, "7d"); got != "99.999% of traces under 2000 ms over 7d · all services" {
		t.Errorf("three-decimal target = %q", got)
	}

	breached := sloMeasure(984, 1000, 99)
	title, detail := sloTransitionText("Chat latency", lat, 99, "7d", breached, statusBreached)
	if title != "Chat latency: breached — 98.4% against a 99% target" {
		t.Errorf("breached title = %q", title)
	}
	if detail != "99% of traces under 2000 ms over 7d · all services: 98.4% over the last 7d (984 of 1,000 traces good); 160% of the error budget consumed." {
		t.Errorf("breached detail = %q", detail)
	}

	atRisk := sloMeasure(992, 1000, 99)
	title, _ = sloTransitionText("API availability", avail, 99, "30d", atRisk, statusAtRisk)
	if title != "API availability: at risk — 80% of the error budget consumed" {
		t.Errorf("at-risk title = %q", title)
	}

	healthy := sloMeasure(993, 1000, 99)
	title, _ = sloTransitionText("API availability", avail, 99, "30d", healthy, statusHealthy)
	if title != "API availability: healthy again — 99.3% against a 99% target" {
		t.Errorf("healthy title = %q", title)
	}
}

func TestGroupThousands(t *testing.T) {
	for n, want := range map[int64]string{0: "0", 999: "999", 1000: "1,000", 1234567: "1,234,567", 100: "100"} {
		if got := groupThousands(n); got != want {
			t.Errorf("groupThousands(%d) = %q, want %q", n, got, want)
		}
	}
}
