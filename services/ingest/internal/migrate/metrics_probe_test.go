package migrate

import (
	"context"
	"strings"
	"testing"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/migrations"
)

// Engine-compat probe for the D363 metrics DDL packet (D369, packet §5.1,
// condition 1; hardened by amendment D373): before 0005_metrics.sql is
// trusted, prove on the pinned clickhouse-server:26.3.17.110 that the engine
// constructs the packet's rollups depend on actually work — or, per A1, that
// they do not, in which case this file IS the escalation artifact and no
// substitution is made in the migration to paper over a failure.
//
// Probe tables/queries run under obstack (the only database obstack_ingest
// has DDL grants on, per deploy/compose/clickhouse/users.d/obstack-users.xml)
// using throwaway `probe_*` names, so this file has zero dependency on
// 0005_metrics.sql ever having applied — it is meant to run and report
// *before* that migration is trusted.
func probeConn(t *testing.T) (context.Context, driver.Conn) {
	t.Helper()
	ctx := requireClickHouse(t)

	opts, err := clickhouse.ParseDSN(testDSN())
	if err != nil {
		t.Fatalf("parse test DSN: %v", err)
	}
	opts.Auth.Database = "obstack"
	conn, err := clickhouse.Open(opts)
	if err != nil {
		t.Fatalf("open clickhouse: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return ctx, conn
}

// TestEngineProbe_SumForEachArray proves AggregateFunction(sumForEach,
// Array(UInt64)) round-trips through State/Merge in an AggregatingMergeTree —
// the construct metric_points_1m/_1h use for hist_counts. This is a state
// combinator, not a SimpleAggregateFunction, so it sits outside the D373
// type-match hardening below and is proven by round-trip instead.
func TestEngineProbe_SumForEachArray(t *testing.T) {
	ctx, conn := probeConn(t)
	const table = "obstack.probe_sumforeach"
	t.Cleanup(func() { conn.Exec(context.Background(), "DROP TABLE IF EXISTS "+table) })

	if err := conn.Exec(ctx, "DROP TABLE IF EXISTS "+table); err != nil {
		t.Fatalf("drop: %v", err)
	}
	if err := conn.Exec(ctx, `
CREATE TABLE `+table+`
(
    id UInt64,
    hist_counts AggregateFunction(sumForEach, Array(UInt64))
)
ENGINE = AggregatingMergeTree
ORDER BY id`); err != nil {
		t.Fatalf("CREATE with AggregateFunction(sumForEach, Array(UInt64)) failed against the pinned engine: %v", err)
	}

	if err := conn.Exec(ctx, "INSERT INTO "+table+" SELECT 1, sumForEachState([toUInt64(1), toUInt64(2)])"); err != nil {
		t.Fatalf("insert state 1: %v", err)
	}
	if err := conn.Exec(ctx, "INSERT INTO "+table+" SELECT 1, sumForEachState([toUInt64(3), toUInt64(4)])"); err != nil {
		t.Fatalf("insert state 2: %v", err)
	}

	rows, err := conn.Query(ctx, "SELECT sumForEachMerge(hist_counts) FROM "+table+" GROUP BY id")
	if err != nil {
		t.Fatalf("sumForEachMerge query: %v", err)
	}
	defer rows.Close()
	if !rows.Next() {
		t.Fatalf("expected one merged row, got none")
	}
	var merged []uint64
	if err := rows.Scan(&merged); err != nil {
		t.Fatalf("scan merged: %v", err)
	}
	t.Logf("PROBE PASS: sumForEach merged two per-block states [1,2]+[3,4] -> %v (want [4 6])", merged)
	if len(merged) != 2 || merged[0] != 4 || merged[1] != 6 {
		t.Fatalf("sumForEachMerge = %v, want [4 6]", merged)
	}
}

// TestEngineProbe_LastSeenColumnTTL proves a table TTL expressed directly
// against a SimpleAggregateFunction(max, DateTime) column (metric_series'
// `TTL last_seen + INTERVAL 90 DAY`) is accepted and the column readable.
func TestEngineProbe_LastSeenColumnTTL(t *testing.T) {
	ctx, conn := probeConn(t)
	const table = "obstack.probe_last_seen_ttl"
	t.Cleanup(func() { conn.Exec(context.Background(), "DROP TABLE IF EXISTS "+table) })

	if err := conn.Exec(ctx, "DROP TABLE IF EXISTS "+table); err != nil {
		t.Fatalf("drop: %v", err)
	}
	if err := conn.Exec(ctx, `
CREATE TABLE `+table+`
(
    id UInt64,
    last_seen SimpleAggregateFunction(max, DateTime('UTC'))
)
ENGINE = AggregatingMergeTree
ORDER BY id
TTL last_seen + INTERVAL 90 DAY`); err != nil {
		t.Fatalf("CREATE with TTL last_seen + INTERVAL 90 DAY failed against the pinned engine: %v", err)
	}

	if err := conn.Exec(ctx, "INSERT INTO "+table+" SELECT 1, now()"); err != nil {
		t.Fatalf("insert: %v", err)
	}
	rows, err := conn.Query(ctx, "SELECT last_seen FROM "+table+" WHERE id = 1")
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	defer rows.Close()
	if !rows.Next() {
		t.Fatalf("expected one row, got none")
	}
	t.Logf("PROBE PASS: last_seen-column TTL accepted and row inserted/read back")
}

// TestEngineProbe_SimpleAggregateFunctionTypesMatchDDL is the D373 hardening:
// D373 was discovered because a SimpleAggregateFunction column's declared
// storage type must equal the aggregate function's actual return type on this
// engine build, and `anyLast(Map(LowCardinality(String), String))` silently
// strips the LowCardinality wrapper — a class of mismatch that is invisible by
// inspection and only surfaces as a CREATE TABLE failure (code 36). Rather
// than re-probe one column, it asserts `toTypeName(fn(x)) == the declared
// storage type` for every (function, type) pairing a SimpleAggregateFunction
// column declares — one run, whole-DDL coverage.
//
// The pairings are READ OUT OF the shipped 0005_metrics.sql rather than
// hand-copied from it, so a column added or retyped later is probed by this
// same run instead of drifting past a stale list. Comments are stripped first
// (SplitStatements): the migration's own D373 note quotes the rejected
// `Map(LowCardinality(String), String)` pairing in prose, and probing prose
// would fail the build for a line that ships nothing.
//
// (gauge_avg, gauge_last, hist_counts are AggregateFunction, not
// SimpleAggregateFunction — they carry State bytes, not a plain value, so this
// class of mismatch does not apply to them; sumForEach, the one the packet
// called out, is proven by round-trip above.)
func TestEngineProbe_SimpleAggregateFunctionTypesMatchDDL(t *testing.T) {
	ctx, conn := probeConn(t)

	body, err := migrations.FS.ReadFile(metricsMigration)
	if err != nil {
		t.Fatalf("read %s: %v", metricsMigration, err)
	}
	for _, p := range simpleAggregatePairings(t, string(body)) {
		t.Run(p.fn+" "+p.declared, func(t *testing.T) {
			// The declared type is compared against itself as the engine
			// canonicalises it, so DDL whitespace never masquerades as a
			// mismatch — only the aggregate's actual return type can.
			var got, want string
			if err := conn.QueryRow(ctx,
				"SELECT toTypeName("+p.fn+"(defaultValueOfTypeName(?))), toTypeName(defaultValueOfTypeName(?))",
				p.declared, p.declared).Scan(&got, &want); err != nil {
				t.Fatalf("PROBE FAIL (A1 STOP — escalate, no substitution): probing %s(%s) for %s failed: %v",
					p.fn, p.declared, strings.Join(p.columns, ", "), err)
			}
			if got != want {
				t.Fatalf("PROBE FAIL (A1 STOP — escalate, no substitution): %s(%s) returns %s, declared storage type is %s (columns: %s) — mismatch class per D373",
					p.fn, p.declared, got, want, strings.Join(p.columns, ", "))
			}
			t.Logf("PROBE PASS: %s(%s) -> %s matches the declared storage type of %s", p.fn, p.declared, got, strings.Join(p.columns, ", "))
		})
	}
}

const metricsMigration = "0005_metrics.sql"

// saPairing is one distinct (aggregate function, declared underlying type)
// combination the DDL asks the engine to store in a SimpleAggregateFunction
// column, with the columns that declare it named for the escalation report.
type saPairing struct {
	fn       string
	declared string
	columns  []string
}

// simpleAggregatePairings extracts those pairings from a migration body,
// de-duplicated in declaration order.
func simpleAggregatePairings(t *testing.T, sql string) []saPairing {
	t.Helper()

	const marker = "SimpleAggregateFunction("
	body := strings.Join(SplitStatements(sql), "\n")

	var (
		pairings []saPairing
		index    = map[string]int{}
	)
	for offset := 0; ; {
		i := strings.Index(body[offset:], marker)
		if i < 0 {
			break
		}
		open := offset + i + len(marker) - 1
		close := matchParen(t, body, open)
		fn, declared, ok := strings.Cut(body[open+1:close], ",")
		if !ok {
			t.Fatalf("malformed SimpleAggregateFunction args in %s: %q", metricsMigration, body[open+1:close])
		}
		fn, declared = strings.TrimSpace(fn), strings.TrimSpace(declared)

		column := "?"
		if fields := strings.Fields(body[strings.LastIndexByte(body[:offset+i], '\n')+1 : offset+i]); len(fields) > 0 {
			column = fields[0]
		}
		key := fn + "|" + declared
		if at, seen := index[key]; seen {
			pairings[at].columns = append(pairings[at].columns, column)
		} else {
			index[key] = len(pairings)
			pairings = append(pairings, saPairing{fn: fn, declared: declared, columns: []string{column}})
		}
		offset = close + 1
	}

	// A parse that quietly matched nothing would be a green probe proving
	// nothing (D36's hollow-guard shape), so anchor it on the pairing D373 was
	// ruled about: it is in the DDL by ruling, and its absence here means the
	// extraction broke, not that the column went away.
	if _, ok := index["anyLast|Map(String, String)"]; !ok {
		t.Fatalf("extraction from %s found %d pairings but not the D373 `anyLast, Map(String, String)` one — extraction is broken or the ruling was undone",
			metricsMigration, len(pairings))
	}
	return pairings
}

// matchParen returns the index of the ")" closing the "(" at open. Types nest
// (Map(String, String), DateTime('UTC')), so the argument list cannot be found
// by scanning for the first ")".
func matchParen(t *testing.T, s string, open int) int {
	t.Helper()
	depth := 0
	for i := open; i < len(s); i++ {
		switch s[i] {
		case '(':
			depth++
		case ')':
			if depth--; depth == 0 {
				return i
			}
		}
	}
	t.Fatalf("unbalanced parentheses in %s at offset %d", metricsMigration, open)
	return -1
}
