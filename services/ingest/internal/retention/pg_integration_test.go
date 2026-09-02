package retention

// The D501 proof against a real Postgres, without ClickHouse: the Postgres leg
// is built from the same seams New wires, pointed at a throwaway migrated
// schema. Two tiers, two tables, a backlog past one batch, and the tenancy
// half — the other workspace's out-of-window rows are untouched by the first
// one's sweep.

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func countPG(ctx context.Context, t *testing.T, pool *pgxpool.Pool, table, workspaceID string) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE workspace_id = $1", workspaceID).Scan(&n); err != nil {
		t.Fatalf("count %s for %s: %v", table, workspaceID, err)
	}
	return n
}

func TestSweepEnforcesRetentionOnThePostgresProductTables(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	pgDSN := migratedPGSchema(ctx, t)
	pool, err := pgxpool.New(ctx, pgDSN)
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)

	stamp := time.Now().UnixNano()
	freeWS := fmt.Sprintf("ws_pgret_free_%d", stamp)
	proWS := fmt.Sprintf("ws_pgret_pro_%d", stamp)

	// free resolves through COALESCE (no workspace_plans row); its window is
	// shortened to one day in this throwaway schema so three-day-old rows are
	// outside it while pro's thirty keep them.
	if _, err := pool.Exec(ctx, "UPDATE plans SET retention_days = 1 WHERE id = 'free'"); err != nil {
		t.Fatalf("shorten free: %v", err)
	}
	if _, err := pool.Exec(ctx,
		"INSERT INTO workspaces (id, org_id) VALUES ($1, 'org_ret'), ($2, 'org_ret')", freeWS, proWS); err != nil {
		t.Fatalf("seed workspaces: %v", err)
	}
	if _, err := pool.Exec(ctx, "DELETE FROM workspaces WHERE id NOT IN ($1, $2)", freeWS, proWS); err != nil {
		t.Fatalf("drop the seeded workspaces: %v", err)
	}
	if _, err := pool.Exec(ctx,
		"INSERT INTO workspace_plans (workspace_id, plan_id) VALUES ($1, 'pro')", proWS); err != nil {
		t.Fatalf("seed pro plan: %v", err)
	}

	old := time.Now().Add(-3 * 24 * time.Hour)
	fresh := time.Now()
	for _, ws := range []string{freeWS, proWS} {
		// alert_events: two old, one fresh; rule-less (a test notification's
		// shape), channel-less, so no rule or channel row is needed.
		for i, at := range []time.Time{old, old, fresh} {
			if _, err := pool.Exec(ctx, `INSERT INTO alert_events (id, workspace_id, severity, title, created_at)
				VALUES ($1, $2, 'info', 'seeded', $3)`, fmt.Sprintf("evt_%s_%d", ws, i), ws, at); err != nil {
				t.Fatalf("seed alert_events: %v", err)
			}
		}
		// change_events: a backlog past one batch of OLD-by-at rows that were
		// all RECEIVED just now (created_at defaults to now()) — the proof that
		// the cut is on the event's own time, not receipt — plus one fresh.
		if _, err := pool.Exec(ctx, `INSERT INTO change_events (id, workspace_id, kind, title, at)
			SELECT 'chg_' || $1 || '_' || g, $1, 'deploy', 'seeded', $2 FROM generate_series(1, $3) g`,
			ws, old, pgBatch+1); err != nil {
			t.Fatalf("seed change_events backlog: %v", err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO change_events (id, workspace_id, kind, title, at)
			VALUES ($1, $2, 'config', 'fresh', $3)`, "chg_"+ws+"_fresh", ws, fresh); err != nil {
			t.Fatalf("seed fresh change_event: %v", err)
		}
	}
	for _, ws := range []string{freeWS, proWS} {
		if got := countPG(ctx, t, pool, "alert_events", ws); got != 3 {
			t.Fatalf("%s alert_events before = %d, want 3", ws, got)
		}
		if got := countPG(ctx, t, pool, "change_events", ws); got != int64(pgBatch+2) {
			t.Fatalf("%s change_events before = %d, want %d", ws, got, pgBatch+2)
		}
	}

	s := &Sweeper{
		plans: plansReader(pool),
		del:   func(context.Context, string, string, string, int32) error { return nil },
		pgDel: pgDeleter(pool),
	}
	s.Sweep(ctx)

	// free (1 day): the old rows are gone on both tables, the fresh ones stay;
	// the change_events backlog needed two batches and drained whole.
	if got := countPG(ctx, t, pool, "alert_events", freeWS); got != 1 {
		t.Errorf("free alert_events after = %d, want 1 (the fresh one)", got)
	}
	if got := countPG(ctx, t, pool, "change_events", freeWS); got != 1 {
		t.Errorf("free change_events after = %d, want 1 (the fresh one)", got)
	}
	var freshTitle string
	if err := pool.QueryRow(ctx, "SELECT title FROM change_events WHERE workspace_id = $1", freeWS).Scan(&freshTitle); err != nil || freshTitle != "fresh" {
		t.Errorf("the surviving free change_event is %q (%v), want the fresh one", freshTitle, err)
	}
	// pro (30 days): three-day-old rows are inside the window — untouched,
	// which is also the tenancy half: free's sweep did not reach them.
	if got := countPG(ctx, t, pool, "alert_events", proWS); got != 3 {
		t.Errorf("pro alert_events after = %d, want 3 (untouched)", got)
	}
	if got := countPG(ctx, t, pool, "change_events", proWS); got != int64(pgBatch+2) {
		t.Errorf("pro change_events after = %d, want %d (untouched)", got, pgBatch+2)
	}
}
