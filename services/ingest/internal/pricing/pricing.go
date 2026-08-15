// Package pricing prices an LLM span at ingest time (D9). Cost is computed once,
// on the way in, and stored on the span: a query-time join against a price list
// would have to answer "what did this cost?" with today's prices rather than the
// prices in force when the call was made, and every dashboard would re-derive the
// same number.
//
// A row matches by prefix, not equality, because providers version their models
// in the name (`gpt-4o-mini-2024-07-18`) while the price tracks the family. The
// longest matching prefix wins, so a specific row always beats the family row it
// extends. The request model is priced first and the response model is the
// fallback (D9) — some SDKs report only the resolved model, some only the
// requested alias.
package pricing

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
	pricefile "github.com/Ziadabdelsalam/observer-stack/services/ingest/pricing"
)

// tokensPerMTok converts the table's per-million-token prices to per-token.
const tokensPerMTok = 1_000_000.0

// Rate is one row of the price list: a model-name prefix and the USD price of a
// million input and output tokens.
type Rate struct {
	Match         string  `json:"match"`
	InputPerMTok  float64 `json:"input_per_mtok"`
	OutputPerMTok float64 `json:"output_per_mtok"`
}

// Table is a price list ready for lookups: rows sorted longest-match-first, so
// the first prefix hit is the longest one.
type Table struct {
	rates []Rate
}

// Default is the embedded price list. Loading it is a package-level fact, not a
// runtime step, because a malformed embedded table is a build mistake and the
// service must not boot pricing everything at zero.
var Default = mustLoad(pricefile.JSON)

// Load parses a price list. Rows are validated here rather than at lookup time:
// a duplicate or negative row silently mispricing every span is worse than a
// refusal to start.
func Load(data []byte) (*Table, error) {
	var rates []Rate
	if err := json.Unmarshal(data, &rates); err != nil {
		return nil, fmt.Errorf("parse price list: %w", err)
	}
	if len(rates) == 0 {
		return nil, fmt.Errorf("price list is empty")
	}

	seen := make(map[string]struct{}, len(rates))
	for i, r := range rates {
		// Model names arrive in whatever case the caller's SDK used; Azure
		// deployments in particular are frequently capitalised.
		r.Match = strings.ToLower(strings.TrimSpace(r.Match))
		if r.Match == "" {
			return nil, fmt.Errorf("price list row %d has an empty match", i)
		}
		if r.InputPerMTok < 0 || r.OutputPerMTok < 0 {
			return nil, fmt.Errorf("price list row %q has a negative price", r.Match)
		}
		if _, dup := seen[r.Match]; dup {
			return nil, fmt.Errorf("price list has duplicate match %q", r.Match)
		}
		seen[r.Match] = struct{}{}
		rates[i] = r
	}

	sort.SliceStable(rates, func(i, j int) bool {
		return len(rates[i].Match) > len(rates[j].Match)
	})
	return &Table{rates: rates}, nil
}

func mustLoad(data []byte) *Table {
	t, err := Load(data)
	if err != nil {
		panic("pricing: " + err.Error())
	}
	return t
}

// Lookup returns the row whose match is the longest prefix of model. An empty
// model never matches.
func (t *Table) Lookup(model string) (Rate, bool) {
	model = strings.ToLower(strings.TrimSpace(model))
	if model == "" {
		return Rate{}, false
	}
	for _, r := range t.rates {
		if strings.HasPrefix(model, r.Match) {
			return r, true
		}
	}
	return Rate{}, false
}

// Cost prices one LLM span in USD (D9). An unpriced model costs 0 and is
// counted under obstack_ingest_unpriced_models_total{model} — a span whose cost
// is missing must be visible as a gap in the table, not as a cheap call.
func (t *Table) Cost(requestModel, responseModel string, inputTokens, outputTokens int64) float64 {
	rate, ok := t.Lookup(requestModel)
	if !ok {
		rate, ok = t.Lookup(responseModel)
	}
	if !ok {
		// Both empty means the span carried no model at all — nothing to price
		// and nothing a new pricing row could fix, so it is not a gap.
		if model := firstModel(requestModel, responseModel); model != "" {
			metrics.UnpricedModels.WithLabelValues(model).Inc()
		}
		return 0
	}
	return float64(inputTokens)*rate.InputPerMTok/tokensPerMTok +
		float64(outputTokens)*rate.OutputPerMTok/tokensPerMTok
}

// firstModel returns the first model name that is actually there, normalised the
// way Lookup normalises it: the counter answers "which row is the table missing?",
// so one missing row must be one series, not one per spelling the caller's SDK
// happened to send.
func firstModel(values ...string) string {
	for _, v := range values {
		if v = strings.ToLower(strings.TrimSpace(v)); v != "" {
			return v
		}
	}
	return ""
}
