package pricing

import (
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
)

// A fixture table keeps the price assertions independent of the real price list,
// which changes whenever a provider changes its prices.
const fixture = `{
  "as_of": "2026-01-02",
  "prices": [
    {"match": "gpt-4o",      "input_per_mtok": 2.5, "output_per_mtok": 10},
    {"match": "gpt-4o-mini", "input_per_mtok": 0.15, "output_per_mtok": 0.6},
    {"match": "claude-sonnet-4", "input_per_mtok": 3, "output_per_mtok": 15}
  ]
}`

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
	before := metrics.UnpricedModelCounts()[model]

	if got := table.Cost(model, "some-unlisted-model-v9-2026", 1_000_000, 1_000_000); got != 0 {
		t.Errorf("Cost(unpriced) = %v, want 0", got)
	}
	if got, want := metrics.UnpricedModelCounts()[model], before+1; got != want {
		t.Errorf("obstack_ingest_unpriced_models_total{model=%q} = %v, want %v", model, got, want)
	}

	// The same missing row spelled differently is the same missing row, not a
	// second series.
	if got := table.Cost("Some-Unlisted-Model-V9", "", 1, 1); got != 0 {
		t.Errorf("Cost(unpriced, mixed case) = %v, want 0", got)
	}
	if got, want := metrics.UnpricedModelCounts()[model], before+2; got != want {
		t.Errorf("obstack_ingest_unpriced_models_total{model=%q} = %v, want %v (case variant made its own series)", model, got, want)
	}
}

func TestCostWithoutAnyModelIsNotCounted(t *testing.T) {
	table := fixtureTable(t)

	if got := table.Cost("", "  ", 10, 10); got != 0 {
		t.Errorf("Cost(no model) = %v, want 0", got)
	}
	if _, counted := metrics.UnpricedModelCounts()[""]; counted {
		t.Error("a span carrying no model at all made an empty-label series")
	}
}

// D29: the `model` label is whatever the caller's SDK sent, so the number of
// series one process can ever hold is capped. This drives far more distinct
// hostile names than the cap and asserts both halves — nothing beyond the cap
// gets its own series, and no count is lost, it lands in the overflow bucket.
// Red by raising maxUnpricedModelLabels above the number of names driven here.
//
// It admits names to a cap that is counted per process lifetime, so it burns the
// label space for the rest of this binary's run: any test that needs a pristine
// one belongs above it. Source order is load-bearing.
func TestUnpricedModelLabelsAreCapped(t *testing.T) {
	table := fixtureTable(t)
	names := hostileModelNames(150)
	if len(names) <= metrics.MaxUnpricedModelLabels {
		t.Fatalf("corpus of %d names does not exceed the cap of %d", len(names), metrics.MaxUnpricedModelLabels)
	}
	distinct := map[string]struct{}{}
	for _, name := range names {
		distinct[name] = struct{}{}
	}
	if len(distinct) != len(names) {
		t.Fatalf("corpus holds %d distinct names of %d — the cap is about distinct labels", len(distinct), len(names))
	}

	before := metrics.UnpricedModelCounts()
	for _, name := range names {
		if got := table.Cost(name, "", 1_000, 1_000); got != 0 {
			t.Fatalf("Cost(%q) = %v, want 0 — the hostile corpus must stay unpriced", name, got)
		}
	}
	after := metrics.UnpricedModelCounts()

	var own, ownSeries float64
	for _, name := range names {
		if delta := after[name] - before[name]; delta > 0 {
			own += delta
			ownSeries++
		}
	}
	if ownSeries > metrics.MaxUnpricedModelLabels {
		t.Errorf("%v of %d hostile model names got their own series, cap is %d",
			ownSeries, len(names), metrics.MaxUnpricedModelLabels)
	}

	// Every increment is still counted: the cap collapses labels, it does not
	// drop spans.
	overflow := after[metrics.UnpricedModelOverflow] - before[metrics.UnpricedModelOverflow]
	if got, want := own+overflow, float64(len(names)); got != want {
		t.Errorf("counted %v increments (%v under own labels, %v under %q), want %v",
			got, own, overflow, metrics.UnpricedModelOverflow, want)
	}
	if overflow == 0 {
		t.Errorf("%d distinct model names past the cap produced no %q increments",
			len(names), metrics.UnpricedModelOverflow)
	}

	// The whole counter, not just this test's names, stays bounded.
	if len(after) > metrics.MaxUnpricedModelLabels+1 {
		t.Errorf("obstack_ingest_unpriced_models_total holds %d series, want at most %d (cap + overflow)",
			len(after), metrics.MaxUnpricedModelLabels+1)
	}
}

// hostileModelNames returns n distinct model strings of the shape a caller can
// actually put in gen_ai.request.model — the D68 corpus classes (injection,
// traversal, control characters, unicode, absurd length) rather than n copies of
// "model-i", because the cap has to hold against names chosen to break it.
func hostileModelNames(n int) []string {
	shapes := []string{
		"model-%d",
		"'; DROP TABLE spans; --%d",
		"../../etc/passwd#%d",
		"model\n\r\twith\x00controls-%d",
		"模型-%d",
		"🙂-%d",
		"{\"match\":\"gpt-4o\"}-%d",
		"model{label=\"x\"}-%d",
		"%d-" + strings.Repeat("very-long-", 200),
		" \t Model-%d ",
	}
	names := make([]string, 0, n)
	for i := 0; len(names) < n; i++ {
		shape := shapes[i%len(shapes)]
		names = append(names, strings.ToLower(strings.TrimSpace(fmt.Sprintf(shape, i))))
	}
	return names
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
	const row = `{"match": "gpt-4o", "input_per_mtok": 1, "output_per_mtok": 1}`
	for _, tc := range []struct{ name, data string }{
		{"not json", `{`},
		{"missing envelope", `{"prices": [` + row + `]}`},
		{"empty", `{"as_of": "2026-01-02", "prices": []}`},
		{"empty match", `{"as_of": "2026-01-02", "prices": [{"match": "", "input_per_mtok": 1, "output_per_mtok": 1}]}`},
		{"negative price", `{"as_of": "2026-01-02", "prices": [{"match": "gpt-4o", "input_per_mtok": -1, "output_per_mtok": 1}]}`},
		{"duplicate match", `{"as_of": "2026-01-02", "prices": [` + row + `,
		                      {"match": "GPT-4O", "input_per_mtok": 2, "output_per_mtok": 2}]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Load([]byte(tc.data)); err == nil {
				t.Fatal("Load succeeded, want error")
			}
		})
	}
}

// D29: the file used to be a bare array. A price list that loads with no date is
// a price list nobody can date, so the old shape is refused loudly rather than
// defaulted — and the refusal happens at boot, since Default is a package-level
// mustLoad.
func TestLoadRefusesBareArray(t *testing.T) {
	for _, tc := range []struct{ name, data string }{
		{"the pre-envelope shape", `[{"match": "gpt-4o", "input_per_mtok": 1, "output_per_mtok": 1}]`},
		{"empty array", `[]`},
		{"leading whitespace", "\n  [{\"match\": \"gpt-4o\", \"input_per_mtok\": 1, \"output_per_mtok\": 1}]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load([]byte(tc.data))
			if err == nil {
				t.Fatal("Load accepted a bare array, want a refusal naming the envelope")
			}
			if !strings.Contains(err.Error(), "as_of") || !strings.Contains(err.Error(), "prices") {
				t.Errorf("Load error = %q, want it to name the {as_of, prices} envelope", err)
			}
		})
	}

	// The refusal is a panic on the way in, not a table of zeroes.
	defer func() {
		if recover() == nil {
			t.Error("mustLoad accepted a bare array, want panic")
		}
	}()
	mustLoad([]byte(`[{"match": "gpt-4o", "input_per_mtok": 1, "output_per_mtok": 1}]`))
}

func TestLoadValidatesAsOfIsARealDate(t *testing.T) {
	const rows = `, "prices": [{"match": "gpt-4o", "input_per_mtok": 1, "output_per_mtok": 1}]}`
	for _, tc := range []struct{ name, asOf string }{
		{"absent", ""},
		{"not a date", "recently"},
		{"wrong order", "02-01-2026"},
		{"month out of range", "2026-13-02"},
		{"day out of range", "2026-02-30"},
		{"timestamp", "2026-01-02T03:04:05Z"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Load([]byte(`{"as_of": "` + tc.asOf + `"` + rows)); err == nil {
				t.Fatalf("Load accepted as_of %q, want error", tc.asOf)
			}
		})
	}

	table, err := Load([]byte(`{"as_of": "2024-02-29"` + rows)) // leap day, a real date
	if err != nil {
		t.Fatalf("Load(leap day): %v", err)
	}
	if table.AsOf != "2024-02-29" {
		t.Errorf("AsOf = %q, want 2024-02-29", table.AsOf)
	}
}

func TestDefaultTableCarriesItsDate(t *testing.T) {
	if _, err := time.Parse(time.DateOnly, Default.AsOf); err != nil {
		t.Errorf("embedded prices.json as_of = %q, want a YYYY-MM-DD date: %v", Default.AsOf, err)
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

func closeTo(got, want float64) bool {
	return math.Abs(got-want) < 1e-9
}
