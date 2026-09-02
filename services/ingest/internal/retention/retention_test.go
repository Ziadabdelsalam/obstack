package retention

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The sweep's fan-out: every workspace hits every table with its own tier.
func TestSweepDeletesEveryTablePerWorkspace(t *testing.T) {
	type call struct {
		table       string
		workspaceID string
		days        int32
	}
	var calls []call

	s := &Sweeper{
		plans: func(context.Context) ([]workspaceRetention, error) {
			return []workspaceRetention{
				{workspaceID: "w_free", retentionDays: 7},
				{workspaceID: "w_pro", retentionDays: 30},
			}, nil
		},
		del: func(_ context.Context, table, _, workspaceID string, days int32) error {
			calls = append(calls, call{table, workspaceID, days})
			return nil
		},
	}
	s.Sweep(context.Background())

	want := []call{
		{"spans", "w_free", 7}, {"logs", "w_free", 7}, {"trace_summaries", "w_free", 7},
		{"metric_points_1m", "w_free", 7}, {"metric_points_1h", "w_free", 7}, {"metric_series", "w_free", 7},
		{"spans", "w_pro", 30}, {"logs", "w_pro", 30}, {"trace_summaries", "w_pro", 30},
		{"metric_points_1m", "w_pro", 30}, {"metric_points_1h", "w_pro", 30}, {"metric_series", "w_pro", 30},
	}
	if len(calls) != len(want) {
		t.Fatalf("got %d deletes %v, want %d", len(calls), calls, len(want))
	}
	for i := range want {
		if calls[i] != want[i] {
			t.Errorf("delete %d = %v, want %v", i, calls[i], want[i])
		}
	}
}

// One workspace's failure must not starve the rest of their retention.
func TestSweepContinuesPastAFailedWorkspace(t *testing.T) {
	var swept []string
	s := &Sweeper{
		plans: func(context.Context) ([]workspaceRetention, error) {
			return []workspaceRetention{
				{workspaceID: "w_broken", retentionDays: 7},
				{workspaceID: "w_fine", retentionDays: 30},
			}, nil
		},
		del: func(_ context.Context, table, _, workspaceID string, _ int32) error {
			if workspaceID == "w_broken" {
				return errors.New("mutation queue wedged")
			}
			swept = append(swept, workspaceID+"/"+table)
			return nil
		},
	}
	s.Sweep(context.Background())

	if len(swept) != len(deletes) {
		t.Fatalf("healthy workspace swept %v, want its %d tables", swept, len(deletes))
	}
}

// A non-positive tier would delete a workspace's entire history; the sweep
// refuses it rather than trusting it.
func TestSweepRefusesNonPositiveRetention(t *testing.T) {
	deletesIssued := 0
	s := &Sweeper{
		plans: func(context.Context) ([]workspaceRetention, error) {
			return []workspaceRetention{{workspaceID: "w", retentionDays: 0}}, nil
		},
		del: func(context.Context, string, string, string, int32) error {
			deletesIssued++
			return nil
		},
	}
	s.Sweep(context.Background())

	if deletesIssued != 0 {
		t.Fatalf("issued %d deletes for a zero-day tier, want 0", deletesIssued)
	}
}

// A failed plan read is a skipped sweep, never a sweep with invented tiers.
func TestSweepSkipsWhenPlansUnreadable(t *testing.T) {
	s := &Sweeper{
		plans: func(context.Context) ([]workspaceRetention, error) {
			return nil, errors.New("postgres away")
		},
		del: func(context.Context, string, string, string, int32) error {
			t.Fatal("deleted with no plan data")
			return nil
		},
	}
	s.Sweep(context.Background())
}

// A cancelled context stops the fan-out between statements — shutdown is never
// held hostage by the rest of a sweep.
func TestSweepStopsOnContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	deletesIssued := 0
	s := &Sweeper{
		plans: func(context.Context) ([]workspaceRetention, error) {
			return []workspaceRetention{
				{workspaceID: "w1", retentionDays: 7},
				{workspaceID: "w2", retentionDays: 7},
			}, nil
		},
		del: func(context.Context, string, string, string, int32) error {
			deletesIssued++
			cancel()
			return nil
		},
	}
	s.Sweep(ctx)

	if deletesIssued != 1 {
		t.Fatalf("issued %d deletes, want the sweep to stop at the statement after the cancel", deletesIssued)
	}
}

// The plan query carries the D163 absent-row=free rule in the SQL itself, and
// the summaries delete cuts on max_seen_date per the retained semantic.
func TestStatementsCarryTheirRules(t *testing.T) {
	if !strings.Contains(plansSQL, `COALESCE(wp.plan_id, 'free')`) {
		t.Error("plansSQL lost the D163 absent-row=free rule")
	}
	if !strings.Contains(deletes[2].sql, "max_seen_date") {
		t.Error("trace_summaries delete must cut on max_seen_date")
	}
	for _, d := range deletes {
		if !strings.Contains(d.sql, "workspace_id = ?") {
			t.Errorf("%s delete is not workspace-scoped: %s", d.table, d.sql)
		}
	}
}

// D363 packet §4: metric_points_1m/_1h key on max_seen_date (the summaries'
// own semantic), metric_series keys on last_seen, and raw metric_points is
// never a sweep target — its retention is the flat 3-day table TTL only.
func TestMetricsTablesCarryTheirRules(t *testing.T) {
	byTable := map[string]string{}
	for _, d := range deletes {
		byTable[d.table] = d.sql
		if strings.Contains(d.sql, "obstack.metric_points ") || strings.HasSuffix(strings.TrimSpace(d.sql), "obstack.metric_points") {
			t.Errorf("%s: raw metric_points must never be swept (packet §4: 3-day table TTL only), got: %s", d.table, d.sql)
		}
	}

	for _, table := range []string{"metric_points_1m", "metric_points_1h", "metric_series"} {
		sql, ok := byTable[table]
		if !ok {
			t.Fatalf("%s is missing from the swept-table list, it must join in place per packet §4", table)
		}
		if !strings.Contains(sql, "workspace_id = ?") {
			t.Errorf("%s delete is not workspace-scoped: %s", table, sql)
		}
	}
	if !strings.Contains(byTable["metric_points_1m"], "max_seen_date") {
		t.Error("metric_points_1m delete must cut on max_seen_date")
	}
	if !strings.Contains(byTable["metric_points_1h"], "max_seen_date") {
		t.Error("metric_points_1h delete must cut on max_seen_date")
	}
	if !strings.Contains(byTable["metric_series"], "last_seen") {
		t.Error("metric_series delete must cut on last_seen")
	}
	if _, swept := byTable["metric_points"]; swept {
		t.Error("raw metric_points must not be in the swept-table list")
	}
}

// seedMetricPoint inserts one obstack.metric_points row aged `age` ago,
// flowing through the real MVs into metric_points_1m, metric_points_1h and
// metric_series. Enum/array/map columns ride minimal, valid values — the
// point of the row is its age and identity, not its payload.
func seedMetricPoint(ctx context.Context, t *testing.T, conn driver.Conn, workspaceID, name string, seriesHash uint64, age time.Duration) {
	t.Helper()
	if err := conn.Exec(ctx, `INSERT INTO obstack.metric_points
		(workspace_id, name, type, unit, service, series_hash, timestamp, value, is_monotonic, bounds, bucket_counts, h_sum, h_count, h_min, h_max, attributes, resource_attributes)
		VALUES (?, ?, 'gauge', 'ms', 'svc', ?, ?, 1, 0, [], [], 0, 0, 0, 0, {}, {})`,
		workspaceID, name, seriesHash, time.Now().UTC().Add(-age)); err != nil {
		t.Fatalf("seed metric point %s/%s: %v", workspaceID, name, err)
	}
}

// cleanupMetricsWorkspace mirrors integration_test.go's cleanupWorkspace for
// the four metrics objects, which that helper (owned by T1) does not know
// about.
func cleanupMetricsWorkspace(t *testing.T, conn driver.Conn, workspaceID string) {
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, table := range []string{"metric_points", "metric_points_1m", "metric_points_1h", "metric_series"} {
			if err := conn.Exec(ctx,
				"ALTER TABLE obstack."+table+" DELETE WHERE workspace_id = ?", workspaceID); err != nil {
				t.Logf("cleanup of %s for %s: %v", table, workspaceID, err)
			}
		}
	})
}

// TestSweepEnforcesRetentionOnMetricsRollupsAndSeries is the D363 packet §4
// exit-evidence proof, the trace_summaries proof's shape applied to the three
// metrics objects that joined the sweep: on a real ClickHouse and Postgres,
// one sweep deletes a past-retention metric's row from metric_points_1m,
// metric_points_1h and metric_series while retaining an in-retention metric's
// row on all three — and never touches raw metric_points, whose own flat
// 3-day table TTL is the only bound on it (packet §4).
//
// The tier under test is 'free' shortened to 1 day in this test's throwaway
// schema, not the shipped 7d/30d: both ages must land inside raw's own 3-day TTL
// (6h and 60h) so the proof isolates the SWEEP's behavior — a 45-day-old row
// would exercise raw's own TTL instead and could pass this test even with the
// sweep wrongly deleting from raw.
func TestSweepEnforcesRetentionOnMetricsRollupsAndSeries(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	conn := connectClickHouse(t)
	pgDSN := migratedPGSchema(ctx, t)

	pool, err := pgxpool.New(ctx, pgDSN)
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)

	ws := fmt.Sprintf("ws_ret_metrics_%d", time.Now().UnixNano())
	cleanupMetricsWorkspace(t, conn, ws)

	// The Postgres schema is this test's own throwaway (migratedPGSchema), so
	// the short tier is 'free' itself shortened in place: no second plan row,
	// no workspace_plans row, and the workspace still resolves through the D163
	// COALESCE path the sweep actually uses.
	if _, err := pool.Exec(ctx, "UPDATE plans SET retention_days = 1 WHERE id = 'free'"); err != nil {
		t.Fatalf("shorten the free tier: %v", err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO workspaces (id, org_id) VALUES ($1, 'org_ret')", ws); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
	// Every other workspace the embedded schema seeds (ws_demo) is dropped for
	// the same reason the trace proof drops it: the sweep sees this workspace
	// and nothing else.
	if _, err := pool.Exec(ctx, "DELETE FROM workspaces WHERE id != $1", ws); err != nil {
		t.Fatalf("drop the seeded workspaces: %v", err)
	}

	// fresh (6h) is unconditionally more recent than any 1-day cutoff. old
	// (60h) is chosen so its calendar date is unconditionally BEFORE the
	// cutoff date regardless of time-of-day: max_seen_date compares dates, not
	// instants (the retained semantic, D252), so an age within a day of the
	// exact retention boundary can straddle the same calendar date as the
	// cutoff depending on wall-clock time; 60h clears that by construction
	// (more than 24h past the 1-day cutoff itself, so a date change is
	// guaranteed) while staying under raw's own 72h/3-day table TTL.
	fresh, old := ws+"_fresh", ws+"_old"
	seedMetricPoint(ctx, t, conn, ws, fresh, 1, 6*time.Hour)
	seedMetricPoint(ctx, t, conn, ws, old, 2, 60*time.Hour)

	// Before the sweep every object holds both metrics — asserted on the raw
	// table too, the same vacuous-pass guard the trace proof uses.
	for _, table := range []string{"metric_points", "metric_points_1m", "metric_points_1h", "metric_series"} {
		if got := countWhere(ctx, t, conn, table, ws); got != 2 {
			t.Fatalf("%s holds %d rows before the sweep, want the 2 seeded metrics", table, got)
		}
	}

	sweeper, err := New(ctx, Config{DSN: chTestDSN(), Pool: pool})
	if err != nil {
		t.Fatalf("new sweeper: %v", err)
	}
	t.Cleanup(sweeper.Close)
	sweeper.Sweep(ctx)

	// Naming the survivor, not merely counting it, is what makes this a
	// direction proof: with the comparison flipped the sweep would delete the
	// fresh metric and keep the past-retention one, leaving the same row COUNT
	// on every table.
	for _, table := range []string{"metric_points_1m", "metric_points_1h", "metric_series"} {
		if got := countWhere(ctx, t, conn, table, ws); got != 1 {
			t.Errorf("%s after sweep = %d rows, want 1 (only the in-retention metric)", table, got)
		}
		if got := survivingNames(ctx, t, conn, table, ws); len(got) != 1 || got[0] != fresh {
			t.Errorf("%s after sweep holds %v, want only the in-retention metric %q", table, got, fresh)
		}
	}
	// Raw metric_points is never a sweep target: both rows survive the sweep
	// unchanged, because only the 3-day table TTL bounds it (packet §4), and
	// both ages here are inside that bound.
	if got := countWhere(ctx, t, conn, "metric_points", ws); got != 2 {
		t.Errorf("metric_points after sweep = %d rows, want 2 (raw is not swept)", got)
	}
}

// survivingNames lists the metric names left in `table` for the workspace.
func survivingNames(ctx context.Context, t *testing.T, conn driver.Conn, table, workspaceID string) []string {
	t.Helper()
	rows, err := conn.Query(ctx,
		"SELECT DISTINCT name FROM obstack."+table+" WHERE workspace_id = ? ORDER BY name", workspaceID)
	if err != nil {
		t.Fatalf("read %s names for %s: %v", table, workspaceID, err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan %s name for %s: %v", table, workspaceID, err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read %s names for %s: %v", table, workspaceID, err)
	}
	return names
}

// The Postgres leg's fan-out (D501): every workspace hits both product tables
// with its own tier, after its ClickHouse tables, and a full batch is followed
// by another statement until one comes back short.
func TestSweepDrainsThePostgresTablesPerWorkspace(t *testing.T) {
	type call struct {
		table       string
		workspaceID string
		days        int32
	}
	var calls []call
	// alert_events for w_free has a backlog: two full batches, then a short one.
	remaining := map[string]int64{"w_free/alert_events": 2*pgBatch + 120}

	s := &Sweeper{
		plans: func(context.Context) ([]workspaceRetention, error) {
			return []workspaceRetention{
				{workspaceID: "w_free", retentionDays: 7},
				{workspaceID: "w_pro", retentionDays: 30},
			}, nil
		},
		del: func(context.Context, string, string, string, int32) error { return nil },
		pgDel: func(_ context.Context, table, sql, workspaceID string, days int32) (int64, error) {
			if !strings.Contains(sql, "workspace_id = $1") || !strings.Contains(sql, "LIMIT 5000") {
				t.Errorf("%s: statement lost its workspace scope or its batch bound: %s", table, sql)
			}
			calls = append(calls, call{table, workspaceID, days})
			key := workspaceID + "/" + table
			n := min(remaining[key], pgBatch)
			remaining[key] -= n
			return n, nil
		},
	}
	s.Sweep(context.Background())

	want := []call{
		{"alert_events", "w_free", 7}, {"alert_events", "w_free", 7}, {"alert_events", "w_free", 7},
		{"change_events", "w_free", 7},
		{"alert_events", "w_pro", 30}, {"change_events", "w_pro", 30},
	}
	if len(calls) != len(want) {
		t.Fatalf("got %d postgres deletes %v, want %d %v", len(calls), calls, len(want), want)
	}
	for i := range want {
		if calls[i] != want[i] {
			t.Errorf("postgres delete %d = %v, want %v", i, calls[i], want[i])
		}
	}
}

// A failed Postgres table is counted and skipped; the other table and the
// other workspace still get their sweep.
func TestSweepContinuesPastAFailedPostgresTable(t *testing.T) {
	var swept []string
	s := &Sweeper{
		plans: func(context.Context) ([]workspaceRetention, error) {
			return []workspaceRetention{
				{workspaceID: "w_a", retentionDays: 7},
				{workspaceID: "w_b", retentionDays: 30},
			}, nil
		},
		del: func(context.Context, string, string, string, int32) error { return nil },
		pgDel: func(_ context.Context, table, _, workspaceID string, _ int32) (int64, error) {
			if workspaceID == "w_a" && table == "alert_events" {
				return 0, errors.New("lock timeout")
			}
			swept = append(swept, workspaceID+"/"+table)
			return 0, nil
		},
	}
	s.Sweep(context.Background())

	want := []string{"w_a/change_events", "w_b/alert_events", "w_b/change_events"}
	if fmt.Sprint(swept) != fmt.Sprint(want) {
		t.Errorf("swept %v, want %v", swept, want)
	}
}

// The statements carry the rules the packet froze: alert_events by created_at,
// change_events by the event's own time.
func TestPostgresStatementsCarryTheirRules(t *testing.T) {
	if len(pgDeletes) != 2 {
		t.Fatalf("pgDeletes has %d tables, want alert_events and change_events", len(pgDeletes))
	}
	for _, d := range pgDeletes {
		col := map[string]string{"alert_events": "created_at <", "change_events": "at <"}[d.table]
		if col == "" || !strings.Contains(d.sql, col) {
			t.Errorf("%s does not cut on its ruled column: %s", d.table, d.sql)
		}
		if !strings.Contains(d.sql, "make_interval(days => $2)") {
			t.Errorf("%s does not bind the plan window in days: %s", d.table, d.sql)
		}
	}
}
