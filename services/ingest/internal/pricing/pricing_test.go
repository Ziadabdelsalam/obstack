package pricing

import (
	"math"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
)

// A fixture table keeps the price assertions independent of the real price list,
// which changes whenever a provider changes its prices.
const fixture = `[
  {"match": "gpt-4o",      "input_per_mtok": 2.5, "output_per_mtok": 10},
  {"match": "gpt-4o-mini", "input_per_mtok": 0.15, "output_per_mtok": 0.6},
  {"match": "claude-sonnet-4", "input_per_mtok": 3, "output_per_mtok": 15}
]`

func fixtureTable(t *testing.T) *Table {
	t.Helper()
	table, err := Load([]byte(fixture))
	if err != nil {
		t.Fatalf("Load fixture: %v", err)
	}
	return table
}

func TestCostExactMatch(t *testing.T) {
	table := fixtureTable(t)
	// 1M in at 2.5 + 0.5M out at 10.
	if got, want := table.Cost("gpt-4o", "", 1_000_000, 500_000), 7.5; !closeTo(got, want) {
		t.Errorf("Cost(gpt-4o) = %v, want %v", got, want)
	}
}

func TestCostLongestPrefixWins(t *testing.T) {
	table := fixtureTable(t)
	// gpt-4o is also a prefix of this model; the more specific mini row must win.
	got := table.Cost("gpt-4o-mini-2024-07-18", "", 1_000_000, 1_000_000)
	if want := 0.15 + 0.6; !closeTo(got, want) {
		t.Errorf("Cost(gpt-4o-mini-2024-07-18) = %v, want %v (gpt-4o row leaked)", got, want)
	}
}

func TestCostFallsBackToResponseModel(t *testing.T) {
	table := fixtureTable(t)
	for _, tc := range []struct{ name, request string }{
		{"request model absent", ""},
		{"request model is an unpriced alias", "our-default-model"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := table.Cost(tc.request, "claude-sonnet-4-20250514", 2_000_000, 0)
			if want := 6.0; !closeTo(got, want) {
				t.Errorf("Cost(%q, claude-sonnet-4-…) = %v, want %v", tc.request, got, want)
			}
		})
	}
}

func TestCostUnpricedModelIsZeroAndCounted(t *testing.T) {
	table := fixtureTable(t)
	const model = "some-unlisted-model-v9"
	before := counterValue(t, metrics.UnpricedModels.WithLabelValues(model))

	if got := table.Cost(model, "some-unlisted-model-v9-2026", 1_000_000, 1_000_000); got != 0 {
		t.Errorf("Cost(unpriced) = %v, want 0", got)
	}
	if got, want := counterValue(t, metrics.UnpricedModels.WithLabelValues(model)), before+1; got != want {
		t.Errorf("obstack_ingest_unpriced_models_total{model=%q} = %v, want %v", model, got, want)
	}

	// The same missing row spelled differently is the same missing row, not a
	// second series.
	if got := table.Cost("Some-Unlisted-Model-V9", "", 1, 1); got != 0 {
		t.Errorf("Cost(unpriced, mixed case) = %v, want 0", got)
	}
	if got, want := counterValue(t, metrics.UnpricedModels.WithLabelValues(model)), before+2; got != want {
		t.Errorf("obstack_ingest_unpriced_models_total{model=%q} = %v, want %v (case variant made its own series)", model, got, want)
	}
}

func TestCostWithoutAnyModelIsNotCounted(t *testing.T) {
	table := fixtureTable(t)
	before := counterValue(t, metrics.UnpricedModels.WithLabelValues(""))

	if got := table.Cost("", "  ", 10, 10); got != 0 {
		t.Errorf("Cost(no model) = %v, want 0", got)
	}
	if got := counterValue(t, metrics.UnpricedModels.WithLabelValues("")); got != before {
		t.Errorf("empty model label counted: %v, want %v", got, before)
	}
}

func TestLookupIsCaseInsensitiveAndPrefixOnly(t *testing.T) {
	table := fixtureTable(t)
	if _, ok := table.Lookup("GPT-4o-Mini"); !ok {
		t.Error("Lookup(GPT-4o-Mini) missed, want the gpt-4o-mini row")
	}
	// A prefix of a row is not a match — only the other way round.
	if rate, ok := table.Lookup("gpt-4"); ok {
		t.Errorf("Lookup(gpt-4) matched %q, want no match", rate.Match)
	}
}

func TestLoadRejectsBadTables(t *testing.T) {
	for _, tc := range []struct{ name, data string }{
		{"not json", `{`},
		{"empty", `[]`},
		{"empty match", `[{"match": "", "input_per_mtok": 1, "output_per_mtok": 1}]`},
		{"negative price", `[{"match": "gpt-4o", "input_per_mtok": -1, "output_per_mtok": 1}]`},
		{"duplicate match", `[{"match": "gpt-4o", "input_per_mtok": 1, "output_per_mtok": 1},
		                      {"match": "GPT-4O", "input_per_mtok": 2, "output_per_mtok": 2}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Load([]byte(tc.data)); err == nil {
				t.Fatal("Load succeeded, want error")
			}
		})
	}
}

func TestDefaultTablePricesCurrentModels(t *testing.T) {
	for _, model := range []string{
		"gpt-4o-mini-2024-07-18",
		"gpt-5",
		"o3-mini",
		"claude-sonnet-4-20250514",
		"claude-3-5-haiku-latest",
		"gemini-2.5-flash",
	} {
		if cost := Default.Cost(model, "", 1_000_000, 1_000_000); cost <= 0 {
			t.Errorf("Default.Cost(%q) = %v, want > 0", model, cost)
		}
	}
}

// counterValue reads one series straight off the collector. client_golang's
// testutil helper would do the same, but it pulls a module the ingest binary
// does not otherwise need.
func counterValue(t *testing.T, c prometheus.Counter) float64 {
	t.Helper()
	var m dto.Metric
	if err := c.Write(&m); err != nil {
		t.Fatalf("read counter: %v", err)
	}
	return m.GetCounter().GetValue()
}

func closeTo(got, want float64) bool {
	return math.Abs(got-want) < 1e-9
}
