// Package pricing embeds the obstack model price list (D9). It holds nothing
// but the JSON: the matcher that reads it lives in internal/pricing, and go:embed
// cannot reach across directories, so the table sits here — the path D9 fixes —
// and the matcher imports it, exactly as internal/migrate imports migrations.
package pricing

import _ "embed"

// JSON is the price list: {"as_of": "YYYY-MM-DD", "prices": [{match,
// input_per_mtok, output_per_mtok}, …]}. Prices are USD per million tokens, list
// price as of the file's own date — the numbers are frozen into the binary at
// build time, so the date is the only thing that can tell a reader how old the
// cost on a span is (D29). Whoever edits a row moves as_of with it.
// Per-workspace overrides are M3 and reuse this row shape.
//
//go:embed prices.json
var JSON []byte
