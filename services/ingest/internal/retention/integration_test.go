package retention

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/migrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pgmigrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/migrations"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/pgmigrations"
)

// This file is the D105 both-directions proof, automated: against a real
// ClickHouse and a real Postgres, one sweep deletes rows past each tier's
// cutoff AND retains rows inside it, on two different tiers at once, on all
// three D7 tables — with the summaries populated through the real MV, because
// the retained semantic (summaries cut on max_seen_date) only exists there.
//
// The defaults are the compose stack from deploy/compose; both DSNs override
// for CI (OBSTACK_TEST_CLICKHOUSE_DSN, OBSTACK_TEST_POSTGRES_DSN). Without a
// reachable server the tests skip, the standing convention.
const (
	defaultClickHouseDSN = "clickhouse://obstack_ingest:obstack_ingest_dev@127.0.0.1:9000/obstack"
	defaultPostgresDSN   = "postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack"
)

func chTestDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_CLICKHOUSE_DSN"); dsn != "" {
		return dsn
	}
	return defaultClickHouseDSN
}

func pgTestDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_POSTGRES_DSN"); dsn != "" {
		return dsn
	}
	return defaultPostgresDSN
}

func connectClickHouse(t *testing.T) driver.Conn {
	t.Helper()

	opts, err := clickhouse.ParseDSN(chTestDSN())
	if err != nil {
		t.Fatalf("parse ClickHouse test DSN: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Reachability is probed against `default`, the database migrate.Run itself
	// boots against: on a fresh volume `obstack` does not exist until the
	// migrations create it, and probing it first would report a running server
	// as absent.
	probeOpts := *opts
	probeOpts.Auth.Database = "default"
	probe, err := clickhouse.Open(&probeOpts)
	if err != nil {
		t.Fatalf("open clickhouse: %v", err)
	}
	if err := probe.Ping(ctx); err != nil {
		probe.Close()
		t.Skipf("no ClickHouse at %s (%v); start deploy/compose to run the retention integration tests", chTestDSN(), err)
	}
	probe.Close()

	if _, err := migrate.Run(ctx, chTestDSN(), migrations.FS); err != nil {
		t.Fatalf("apply schema: %v", err)
	}

	conn, err := clickhouse.Open(opts)
	if err != nil {
		t.Fatalf("open clickhouse: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// migratedPGSchema is the keystore suite's isolation pattern: a throwaway
// schema with the whole embedded set applied, its name travelling as
// search_path so every pooled connection lands in it.
func migratedPGSchema(ctx context.Context, t *testing.T) string {
	t.Helper()

	pingCtx, cancelPing := context.WithTimeout(ctx, 5*time.Second)
	defer cancelPing()
	probe, err := pgx.Connect(pingCtx, pgTestDSN())
	if err != nil {
		t.Skipf("no Postgres at %s (%v); start deploy/compose to run the retention integration tests", pgTestDSN(), err)
	}
	probe.Close(ctx)

	name := fmt.Sprintf("retention_test_%d", time.Now().UnixNano())
	conn, err := pgx.Connect(ctx, pgTestDSN())
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)

	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+name); err != nil {
		t.Fatalf("create schema %s: %v", name, err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cleanup, err := pgx.Connect(cleanupCtx, pgTestDSN())
		if err != nil {
			t.Errorf("connect to drop schema %s: %v", name, err)
			return
		}
		defer cleanup.Close(cleanupCtx)
		if _, err := cleanup.Exec(cleanupCtx, "DROP SCHEMA "+name+" CASCADE"); err != nil {
			t.Errorf("drop schema %s: %v", name, err)
		}
	})

	u, err := url.Parse(pgTestDSN())
	if err != nil {
		t.Fatalf("test DSN must be a postgres:// URL for schema scoping: %v", err)
	}
	q := u.Query()
	q.Set("search_path", name)
	u.RawQuery = q.Encode()
	dsn := u.String()

	if _, err := pgmigrate.Run(ctx, dsn, pgmigrations.FS); err != nil {
		t.Fatalf("apply the embedded schema: %v", err)
	}
	return dsn
}

// seedSpan inserts one span aged `age` ago, flowing through the real MV into
// trace_summaries. Enum columns ride their zero defaults.
func seedSpan(ctx context.Context, t *testing.T, conn driver.Conn, workspaceID, traceID string, age time.Duration) {
	t.Helper()
	if err := conn.Exec(ctx, `INSERT INTO obstack.spans
		(workspace_id, trace_id, span_id, name, service, start_time, duration_ns)
		VALUES (?, ?, ?, 'op', 'svc', ?, 1000)`,
		workspaceID, traceID, "s-"+traceID, time.Now().UTC().Add(-age)); err != nil {
		t.Fatalf("seed span %s/%s: %v", workspaceID, traceID, err)
	}
}

func seedLog(ctx context.Context, t *testing.T, conn driver.Conn, workspaceID string, age time.Duration) {
	t.Helper()
	if err := conn.Exec(ctx, `INSERT INTO obstack.logs
		(workspace_id, timestamp, severity_number, body, service)
		VALUES (?, ?, 9, 'line', 'svc')`,
		workspaceID, time.Now().UTC().Add(-age)); err != nil {
		t.Fatalf("seed log %s: %v", workspaceID, err)
	}
}

func countWhere(ctx context.Context, t *testing.T, conn driver.Conn, table, workspaceID string) uint64 {
	t.Helper()
	var count uint64
	row := conn.QueryRow(ctx,
		"SELECT count() FROM obstack."+table+" WHERE workspace_id = ?", workspaceID)
	if err := row.Scan(&count); err != nil {
		t.Fatalf("count %s for %s: %v", table, workspaceID, err)
	}
	return count
}

func cleanupWorkspace(t *testing.T, conn driver.Conn, workspaceID string) {
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, table := range []string{"spans", "logs", "trace_summaries"} {
			if err := conn.Exec(ctx,
				"ALTER TABLE obstack."+table+" DELETE WHERE workspace_id = ?", workspaceID); err != nil {
				t.Logf("cleanup of %s for %s: %v", table, workspaceID, err)
			}
		}
	})
}

// TestSweepEnforcesBothDirectionsOnTwoTiers is the exit-evidence proof:
//   - free (7d, resolved through the D163 absent-row rule): a 3-day-old row is
//     retained, 15- and 45-day-old rows are deleted;
//   - pro (30d, a real workspace_plans row): 3- and 15-day-old rows are
//     retained, a 45-day-old row is deleted;
//
// on spans, logs AND the MV-populated trace_summaries, in one real sweep.
func TestSweepEnforcesBothDirectionsOnTwoTiers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	conn := connectClickHouse(t)
	pgDSN := migratedPGSchema(ctx, t)

	pool, err := pgxpool.New(ctx, pgDSN)
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)

	stamp := time.Now().UnixNano()
	freeWS := fmt.Sprintf("ws_ret_free_%d", stamp)
	proWS := fmt.Sprintf("ws_ret_pro_%d", stamp)
	cleanupWorkspace(t, conn, freeWS)
	cleanupWorkspace(t, conn, proWS)

	// free has no workspace_plans row on purpose — the sweep must resolve it
	// through COALESCE, not through a seeded convenience.
	if _, err := pool.Exec(ctx,
		"INSERT INTO workspaces (id, org_id) VALUES ($1, 'org_ret'), ($2, 'org_ret')", freeWS, proWS); err != nil {
		t.Fatalf("seed workspaces: %v", err)
	}
	if _, err := pool.Exec(ctx,
		"INSERT INTO workspace_plans (workspace_id, plan_id) VALUES ($1, 'pro')", proWS); err != nil {
		t.Fatalf("seed pro plan: %v", err)
	}

	ages := map[string]time.Duration{
		"fresh": 3 * 24 * time.Hour,
		"mid":   15 * 24 * time.Hour,
		"old":   45 * 24 * time.Hour,
	}
	for name, age := range ages {
		for _, ws := range []string{freeWS, proWS} {
			seedSpan(ctx, t, conn, ws, ws+"-t-"+name, age)
			seedLog(ctx, t, conn, ws, age)
		}
	}
	for _, ws := range []string{freeWS, proWS} {
		if got := countWhere(ctx, t, conn, "trace_summaries", ws); got != 3 {
			t.Fatalf("MV populated %d summary rows for %s before the sweep, want 3", got, ws)
		}
	}

	sweeper, err := New(ctx, Config{DSN: chTestDSN(), Pool: pool})
	if err != nil {
		t.Fatalf("new sweeper: %v", err)
	}
	t.Cleanup(sweeper.Close)
	sweeper.Sweep(ctx)

	// Both directions, both tiers, all three tables. free keeps 1 of 3
	// (fresh); pro keeps 2 of 3 (fresh, mid).
	for _, tc := range []struct {
		ws   string
		want uint64
	}{{freeWS, 1}, {proWS, 2}} {
		for _, table := range []string{"spans", "logs", "trace_summaries"} {
			if got := countWhere(ctx, t, conn, table, tc.ws); got != tc.want {
				t.Errorf("%s/%s after sweep = %d rows, want %d", tc.ws, table, got, tc.want)
			}
		}
	}
}
