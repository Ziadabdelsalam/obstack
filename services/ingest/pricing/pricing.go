// Package pricing embeds the obstack model price list (D9). It holds nothing
// but the JSON: the matcher that reads it lives in internal/pricing, and go:embed
// cannot reach across directories, so the table sits here — the path D9 fixes —
// and the matcher imports it, exactly as internal/migrate imports migrations.
package pricing

import _ "embed"

// JSON is the price list, a JSON array of {match, input_per_mtok,
// output_per_mtok} rows. Prices are USD per million tokens, list price at the
// time of writing; per-workspace overrides are M3 and reuse this row shape.
//
//go:embed prices.json
var JSON []byte
