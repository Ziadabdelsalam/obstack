package retention

// The D501 proof against a real Postgres, without ClickHouse: the Postgres leg
// is built from the same seams New wires, pointed at a throwaway migrated
// schema. Two tiers, two tables, a backlog past one batch, and the tenancy
// half — the other workspace's out-of-window rows are untouched by the first
// one's sweep.
//
// The second test is D526's FK action on the same real Postgres: retention's
// OWN alert_events statement, run against an event a person has promoted into
// an incident, under the shipped ON DELETE SET NULL and under the Postgres
// default action it was chosen over.

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
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

// TestSweepDeletingAPromotedAlertEventDoesNotWedge is D526's ruling — the
// nullable `incidents.opened_from_event_id → alert_events (id)` link is
// ON DELETE SET NULL — proven on the one statement that would break under any
// other action: retention's per-workspace ctid batch DELETE on alert_events.
//
// The action is the whole ruling. NO ACTION (the Postgres default) and
// RESTRICT both raise 23503 against that statement, and the sweeper's answer
// to a failed table is to log it, increment sweepFailures, skip the table and
// retry the IDENTICAL statement every interval (Sweep, above) — so one
// promotion wedges that workspace's Postgres leg forever, with retention never
// enforced for it again. CASCADE would delete an operator's postmortem because
// their alert aged out. SET NULL is the only action that neither wedges the
// sweep nor destroys authored prose.
//
// Both halves run here against the same event, the same workspace, the same
// window and the same statement — only the referencing table's FK action
// differs, so the 23503 is attributable to the action and to nothing else.
// D528 is why the incident is still here to be read afterwards: incidents are
// deliberately not swept.
func TestSweepDeletingAPromotedAlertEventDoesNotWedge(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	pgDSN := migratedPGSchema(ctx, t)
	pool, err := pgxpool.New(ctx, pgDSN)
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)

	// The statement under test is the sweep's OWN, looked up by table rather
	// than by position: a retyped DELETE would prove nothing about the
	// statement that actually runs.
	var alertEventsSQL string
	for _, d := range pgDeletes {
		if d.table == "alert_events" {
			alertEventsSQL = d.sql
		}
	}
	if alertEventsSQL == "" {
		t.Fatalf("pgDeletes carries no alert_events statement; this test runs the sweep's own SQL and has none to run")
	}

	// free resolves through COALESCE (no workspace_plans row); its window is
	// shortened to one day in this throwaway schema so a three-day-old event is
	// well past it.
	if _, err := pool.Exec(ctx, "UPDATE plans SET retention_days = 1 WHERE id = 'free'"); err != nil {
		t.Fatalf("shorten free: %v", err)
	}
	ws := fmt.Sprintf("ws_pgwedge_%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, "INSERT INTO workspaces (id, org_id) VALUES ($1, 'org_ret')", ws); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}

	// One alert_events row past the window — rule-less and channel-less, a test
	// notification's shape, so no rule or channel row is needed.
	eventID := "evt_" + ws
	firedAt := time.Now().Add(-3 * 24 * time.Hour)
	if _, err := pool.Exec(ctx, `INSERT INTO alert_events (id, workspace_id, severity, title, created_at)
		VALUES ($1, $2, 'warning', 'checkout latency over budget', $3)`, eventID, ws, firedAt); err != nil {
		t.Fatalf("seed alert_events: %v", err)
	}
	// The promotion, in the shape D526 rules: origin carries the FACT, the
	// nullable pointer carries only the link, started_at is the event's own
	// instant. Nothing else here is derived, because nothing else is what the
	// sweep touches.
	incidentID := "inc_" + ws
	if _, err := pool.Exec(ctx, `INSERT INTO incidents
		(id, workspace_id, title, severity, origin, started_at, opened_from_event_id)
		VALUES ($1, $2, 'checkout latency over budget', 'warning', 'alert', $3, $4)`,
		incidentID, ws, firedAt, eventID); err != nil {
		t.Fatalf("seed the promoted incident: %v", err)
	}
	// The pointer is read back non-NULL BEFORE anything sweeps: without this
	// the IS NULL assertion at the end would pass just as happily against a row
	// that never pointed at an event at all.
	var seeded *string
	if err := pool.QueryRow(ctx,
		"SELECT opened_from_event_id FROM incidents WHERE id = $1", incidentID).Scan(&seeded); err != nil {
		t.Fatalf("read the promoted incident back: %v", err)
	}
	if seeded == nil || *seeded != eventID {
		t.Fatalf("the seeded incident points at %v, want the promoted event %s", seeded, eventID)
	}

	// del is left nil: this test never runs the ClickHouse leg, only the
	// Postgres drain the promotion can wedge.
	s := &Sweeper{plans: plansReader(pool), pgDel: pgDeleter(pool)}

	// The window is READ through the sweep's own plan resolution, not typed —
	// "well past the plan window" is a measured claim about this workspace.
	plans, err := s.plans(ctx)
	if err != nil {
		t.Fatalf("read plans: %v", err)
	}
	var w workspaceRetention
	for _, p := range plans {
		if p.workspaceID == ws {
			w = p
		}
	}
	if w.workspaceID != ws || w.retentionDays != 1 {
		t.Fatalf("the seeded workspace resolved to %+v, want %s on free's shortened 1 day", w, ws)
	}

	// RED first. A second referencing table, same column, same target, declared
	// at the Postgres DEFAULT action — the action D526 rejected.
	if _, err := pool.Exec(ctx, `CREATE TABLE incidents_no_action_probe
		(
		    id                   TEXT PRIMARY KEY,
		    opened_from_event_id TEXT NULL REFERENCES alert_events (id)
		)`); err != nil {
		t.Fatalf("create the NO ACTION probe: %v", err)
	}
	if _, err := pool.Exec(ctx,
		"INSERT INTO incidents_no_action_probe (id, opened_from_event_id) VALUES ('inc_probe', $1)",
		eventID); err != nil {
		t.Fatalf("seed the NO ACTION probe: %v", err)
	}
	// Twice, because the wedge is not the first failure: it is that the
	// sweeper's retry is the same statement against the same rows, so the
	// second interval fails exactly as the first did, and every one after it.
	for attempt := 1; attempt <= 2; attempt++ {
		deleted, err := s.sweepPostgresTable(ctx, "alert_events", alertEventsSQL, w)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
			t.Fatalf("attempt %d under NO ACTION deleted %d and returned %v; want the sweep wedged on 23503",
				attempt, deleted, err)
		}
		if deleted != 0 {
			t.Errorf("attempt %d deleted %d rows, want 0 — the batch is one statement and it did not commit",
				attempt, deleted)
		}
		t.Logf("RED, attempt %d: %s %s", attempt, pgErr.Code, pgErr.Message)
	}
	if got := countPG(ctx, t, pool, "alert_events", ws); got != 1 {
		t.Fatalf("alert_events after the wedged attempts = %d, want the seeded row still there", got)
	}
	// And the shipped row's pointer is still SET after the wedge. The SET NULL
	// fires before the probe's RI check raises, so statement-level rollback is
	// what puts it back; reading it here means the GREEN assertion below tests
	// the sweep's own effect and cannot pass on a pointer nulled by a rolled-
	// back attempt.
	var pointerAfterRed *string
	if err := pool.QueryRow(ctx,
		"SELECT opened_from_event_id FROM incidents WHERE workspace_id = $1", ws,
	).Scan(&pointerAfterRed); err != nil {
		t.Fatalf("read the incident's pointer after the wedged attempts: %v", err)
	}
	if pointerAfterRed == nil {
		t.Fatal("the incident's opened_from_event_id is NULL after the wedged attempts — the rollback did not restore it, so the GREEN assertion below would pass for the wrong reason")
	}

	// GREEN. Drop the probe so the only table referencing the event is the
	// shipped one, whose FK is ON DELETE SET NULL.
	if _, err := pool.Exec(ctx, "DROP TABLE incidents_no_action_probe"); err != nil {
		t.Fatalf("drop the NO ACTION probe: %v", err)
	}
	deleted, err := s.sweepPostgresTable(ctx, "alert_events", alertEventsSQL, w)
	if err != nil {
		t.Fatalf("the sweep's own alert_events statement failed against the shipped schema: %v", err)
	}
	if deleted != 1 {
		t.Errorf("the sweep deleted %d rows, want the 1 out-of-window event", deleted)
	}
	if got := countPG(ctx, t, pool, "alert_events", ws); got != 0 {
		t.Errorf("alert_events after the sweep = %d, want 0 — the event aged out", got)
	}

	// The incident survives its alert, and the FACT survives the pointer: the
	// surface reads "from an alert" off origin, never off the nulled column.
	var (
		openedFrom *string
		origin     string
	)
	if err := pool.QueryRow(ctx,
		"SELECT opened_from_event_id, origin FROM incidents WHERE id = $1", incidentID).Scan(&openedFrom, &origin); err != nil {
		t.Fatalf("the promoted incident did not survive its alert: %v", err)
	}
	if openedFrom != nil {
		t.Errorf("opened_from_event_id = %q after the sweep, want NULL", *openedFrom)
	}
	if origin != "alert" {
		t.Errorf("origin = %q, want alert — a nulled pointer must not make a promoted incident read as manual", origin)
	}
}
