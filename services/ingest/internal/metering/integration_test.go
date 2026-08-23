package metering

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pgmigrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/pgmigrations"
)

// These tests run against a real Postgres, through the real UPSERTs, against the
// real migration. The claim that makes the ledger safe under N replicas — that
// the write adds and never sets, so two flushers landing on the same bucket at
// the same time sum instead of clobbering — is a claim about a server's conflict
// handling, and only a server can settle it.
//
// The default is the compose stack from deploy/compose. Without it, one
// container is enough and is what CI runs too:
//
//	docker run --rm -d --name obstack-metering-test \
//	  -e POSTGRES_USER=obstack -e POSTGRES_PASSWORD=obstack_postgres_dev \
//	  -e POSTGRES_DB=obstack -p 127.0.0.1:5432:5432 postgres:17.11
const defaultDSN = "postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack"

func testDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_POSTGRES_DSN"); dsn != "" {
		return dsn
	}
	return defaultDSN
}

// requirePostgres skips rather than fails when no server is reachable: a laptop
// without the compose stack up should not report broken metering.
func requirePostgres(t *testing.T) context.Context {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)

	pingCtx, cancelPing := context.WithTimeout(ctx, 5*time.Second)
	defer cancelPing()
	conn, err := pgx.Connect(pingCtx, testDSN())
	if err != nil {
		t.Skipf("no Postgres at %s (%v); start deploy/compose or the documented postgres:17.11 container to run the metering integration tests", testDSN(), err)
	}
	conn.Close(ctx)
	return ctx
}

// migratedSchema hands a test its own schema with the whole embedded set applied
// and a DSN scoped to it, the way internal/pgmigrate's own tests isolate.
func migratedSchema(ctx context.Context, t *testing.T) string {
	t.Helper()

	name := fmt.Sprintf("metering_test_%d", time.Now().UnixNano())
	conn, err := pgx.Connect(ctx, testDSN())
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
		cleanup, err := pgx.Connect(cleanupCtx, testDSN())
		if err != nil {
			t.Errorf("connect to drop schema %s: %v", name, err)
			return
		}
		defer cleanup.Close(cleanupCtx)
		if _, err := cleanup.Exec(cleanupCtx, "DROP SCHEMA "+name+" CASCADE"); err != nil {
			t.Errorf("drop schema %s: %v", name, err)
		}
	})

	u, err := url.Parse(testDSN())
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

func exec(ctx context.Context, t *testing.T, dsn, sql string, args ...any) error {
	t.Helper()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)

	_, err = conn.Exec(ctx, sql, args...)
	return err
}

// seed writes the rows the two foreign keys need: two workspaces, each with the
// key that will carry their traffic.
func seed(ctx context.Context, t *testing.T, dsn string) {
	t.Helper()

	if err := exec(ctx, t, dsn,
		"INSERT INTO workspaces (id, org_id) VALUES ('ws_alice', 'org_alice'), ('ws_bob', 'org_bob')"); err != nil {
		t.Fatalf("insert workspaces: %v", err)
	}
	if err := exec(ctx, t, dsn,
		"INSERT INTO api_keys (id, workspace_id, name, prefix, token_hash) VALUES "+
			"('key_alice', 'ws_alice', 'alice', 'ok_live_aaaa', 'hash_alice'), "+
			"('key_bob', 'ws_bob', 'bob', 'ok_live_bbbb', 'hash_bob')"); err != nil {
		t.Fatalf("insert api keys: %v", err)
	}
}

// openMeter is New against a scoped pool, at a clock the test controls so every
// record lands in one known hour bucket.
func openMeter(ctx context.Context, t *testing.T, dsn string, clock *fakeClock) *Meter {
	t.Helper()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect pool: %v", err)
	}
	t.Cleanup(pool.Close)

	m := New(pool)
	m.now = clock.now
	return m
}

func ledgerRow(ctx context.Context, t *testing.T, dsn, workspaceID string) (spans, logs int64, updatedAt time.Time) {
	t.Helper()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)

	if err := conn.QueryRow(ctx,
		"SELECT coalesce(sum(spans), 0), coalesce(sum(logs), 0), coalesce(max(updated_at), 'epoch') FROM usage_ledger WHERE workspace_id = $1",
		workspaceID).Scan(&spans, &logs, &updatedAt); err != nil {
		t.Fatalf("read the ledger for %s: %v", workspaceID, err)
	}
	return spans, logs, updatedAt
}

type health struct {
	accepted           int64
	droppedDecode      int64
	droppedUnsupported int64
	droppedQuota       int64
	lastEventAt        *time.Time
	updatedAt          time.Time
}

func healthRow(ctx context.Context, t *testing.T, dsn, keyID string) health {
	t.Helper()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)

	var h health
	if err := conn.QueryRow(ctx,
		"SELECT accepted, dropped_decode, dropped_unsupported, dropped_quota, last_event_at, updated_at FROM api_key_health WHERE key_id = $1",
		keyID).Scan(&h.accepted, &h.droppedDecode, &h.droppedUnsupported, &h.droppedQuota, &h.lastEventAt, &h.updatedAt); err != nil {
		t.Fatalf("read health for %s: %v", keyID, err)
	}
	return h
}

func testClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 8, 19, 12, 30, 0, 0, time.UTC)}
}

// The row shape end to end: what the accumulator counted is what the ledger and
// the health row say, in the hour bucket the writer truncated to, and a second
// flush adds to the first rather than replacing it.
func TestFlushWritesLedgerAndHealthRows(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := migratedSchema(ctx, t)
	seed(ctx, t, dsn)

	clock := testClock()
	m := openMeter(ctx, t, dsn, clock)

	m.RecordAccepted("ws_alice", "key_alice", 6, 4)
	m.RecordDropped("ws_alice", "key_alice", DropQuota, 3)
	if err := m.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	spans, logs, _ := ledgerRow(ctx, t, dsn, "ws_alice")
	if spans != 6 || logs != 4 {
		t.Errorf("ledger = %d spans / %d logs, want 6/4", spans, logs)
	}
	h := healthRow(ctx, t, dsn, "key_alice")
	if h.accepted != 10 || h.droppedQuota != 3 {
		t.Errorf("health = %+v, want accepted 10 and dropped_quota 3", h)
	}
	if h.lastEventAt == nil || !h.lastEventAt.UTC().Equal(clock.t) {
		t.Errorf("last_event_at = %v, want the accept at %s", h.lastEventAt, clock.t)
	}

	// The bucket is the truncated UTC hour, which is what makes a closed hour a
	// fact the reporter can re-send (D170).
	var bucket time.Time
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)
	if err := conn.QueryRow(ctx, "SELECT period_start FROM usage_ledger WHERE workspace_id = 'ws_alice'").Scan(&bucket); err != nil {
		t.Fatalf("read the bucket: %v", err)
	}
	if want := clock.t.Truncate(time.Hour); !bucket.UTC().Equal(want) {
		t.Errorf("period_start = %s, want the truncated UTC hour %s", bucket.UTC(), want)
	}

	// The second flush adds. If this ever set instead, every replica would be
	// overwriting every other one's usage.
	m.RecordAccepted("ws_alice", "key_alice", 1, 2)
	m.RecordDropped("ws_alice", "key_alice", DropDecode, 5)
	if err := m.Flush(ctx); err != nil {
		t.Fatalf("second Flush: %v", err)
	}
	spans, logs, _ = ledgerRow(ctx, t, dsn, "ws_alice")
	if spans != 7 || logs != 6 {
		t.Errorf("ledger after the second flush = %d spans / %d logs, want 7/6", spans, logs)
	}
	h = healthRow(ctx, t, dsn, "key_alice")
	if h.accepted != 13 || h.droppedQuota != 3 || h.droppedDecode != 5 {
		t.Errorf("health after the second flush = %+v, want accepted 13, dropped_quota 3, dropped_decode 5", h)
	}

	// A flush carrying only drops must not erase the key's last event: the
	// UPSERT takes the GREATEST, and a NULL from this flush is not a newer one.
	before := *h.lastEventAt
	m.RecordDropped("ws_alice", "key_alice", DropUnsupported, 1)
	if err := m.Flush(ctx); err != nil {
		t.Fatalf("drops-only Flush: %v", err)
	}
	h = healthRow(ctx, t, dsn, "key_alice")
	if h.lastEventAt == nil || !h.lastEventAt.Equal(before) {
		t.Errorf("last_event_at = %v after a drops-only flush, want it left at %s", h.lastEventAt, before)
	}

	// The windowed rows (D260), read back from the server rather than trusted:
	// this is the only place an inverted trim predicate or a SET-instead-of-add
	// would be caught, and its symptom in the product — a rate that reads "—"
	// forever — is indistinguishable from nothing having arrived.
	minute := clock.t.Truncate(time.Minute)
	if got := windowAccepted(ctx, t, dsn, "key_alice", minute); got != 13 {
		t.Errorf("window bucket at %s = %d accepted, want the same 13 the cumulative row holds", minute, got)
	}

	// Past the retention, the same flush that writes the new bucket deletes the
	// old one — the property that bounds this table with nothing scheduled.
	clock.advance(windowRetention + time.Minute)
	m.RecordAccepted("ws_alice", "key_alice", 2, 0)
	if err := m.Flush(ctx); err != nil {
		t.Fatalf("post-retention Flush: %v", err)
	}
	if got := windowAccepted(ctx, t, dsn, "key_alice", minute); got != -1 {
		t.Errorf("the bucket at %s survived past the retention with %d accepted, want it deleted", minute, got)
	}
	fresh := clock.t.Truncate(time.Minute)
	if got := windowAccepted(ctx, t, dsn, "key_alice", fresh); got != 2 {
		t.Errorf("window bucket at %s = %d accepted, want 2", fresh, got)
	}
}

// windowAccepted reads one bucket's accepted count, or -1 when the row is not
// there — the two outcomes the retention proof has to tell apart.
func windowAccepted(ctx context.Context, t *testing.T, dsn, keyID string, bucket time.Time) int64 {
	t.Helper()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)

	var accepted int64
	err = conn.QueryRow(ctx,
		"SELECT accepted FROM api_key_health_windows WHERE key_id = $1 AND bucket_start = $2",
		keyID, bucket).Scan(&accepted)
	if errors.Is(err, pgx.ErrNoRows) {
		return -1
	}
	if err != nil {
		t.Fatalf("read the window bucket: %v", err)
	}
	return accepted
}

// The load-bearing claim, against the server that has to honor it: two flushers
// writing the same buckets and the same health rows at the same time sum. This
// is what "correct under N replicas by construction" means — no leader, no
// lease, no watermark, just an UPSERT that adds.
func TestConcurrentFlushersAddRatherThanSet(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := migratedSchema(ctx, t)
	seed(ctx, t, dsn)

	clock := testClock()
	// Two meters on two pools: two processes, as far as Postgres can tell.
	first := openMeter(ctx, t, dsn, clock)
	second := openMeter(ctx, t, dsn, clock)

	const (
		rounds     = 40
		perRound   = 3
		wantSpans  = int64(rounds * perRound)
		wantLogs   = int64(rounds * perRound * 2)
		wantAccept = wantSpans + wantLogs
	)

	// Each flusher touches both workspaces, in the opposite order, so the row
	// locks are contended: without the fixed row ordering inside a flush this is
	// exactly the shape that deadlocks.
	run := func(m *Meter, forward bool, errs chan<- error) {
		for i := 0; i < rounds; i++ {
			if forward {
				m.RecordAccepted("ws_alice", "key_alice", perRound, perRound*2)
				m.RecordAccepted("ws_bob", "key_bob", perRound, perRound*2)
			} else {
				m.RecordAccepted("ws_bob", "key_bob", perRound, perRound*2)
				m.RecordAccepted("ws_alice", "key_alice", perRound, perRound*2)
			}
			if err := m.Flush(ctx); err != nil {
				errs <- err
				return
			}
		}
	}

	errs := make(chan error, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); run(first, true, errs) }()
	go func() { defer wg.Done(); run(second, false, errs) }()
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent flush: %v", err)
	}

	for _, workspaceID := range []string{"ws_alice", "ws_bob"} {
		spans, logs, _ := ledgerRow(ctx, t, dsn, workspaceID)
		if spans != 2*wantSpans || logs != 2*wantLogs {
			t.Errorf("%s ledger = %d spans / %d logs, want %d/%d — a concurrent flush clobbered instead of adding",
				workspaceID, spans, logs, 2*wantSpans, 2*wantLogs)
		}
	}
	for _, keyID := range []string{"key_alice", "key_bob"} {
		// The same add-never-set claim the migration file leads with, on the
		// windowed rows: two flushers, one bucket, both counts present.
		if got := windowSum(ctx, t, dsn, keyID); got != 2*wantAccept {
			t.Errorf("window rows for %s sum to %d accepted, want %d — the buckets SET instead of adding",
				keyID, got, 2*wantAccept)
		}
		if got := healthRow(ctx, t, dsn, keyID); got.accepted != 2*wantAccept {
			t.Errorf("%s accepted = %d, want %d — a concurrent flush clobbered instead of adding",
				keyID, got.accepted, 2*wantAccept)
		}
	}

	// One bucket per workspace, not one per flush: the hour is the grain, and
	// the reporter's idempotency depends on it staying that way.
	var buckets int
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)
	if err := conn.QueryRow(ctx, "SELECT count(*) FROM usage_ledger").Scan(&buckets); err != nil {
		t.Fatalf("count the buckets: %v", err)
	}
	if buckets != 2 {
		t.Errorf("the ledger holds %d rows, want one hour bucket per workspace", buckets)
	}
}

// A workspace deleted mid-flight costs the snapshot it was in — the flush is one
// transaction, so ws_alice's counts in that same snapshot go with it — and
// nothing after it: the rejected snapshot is discarded rather than retried
// forever, so the next flush, everyone else's usage, still lands.
func TestFlushSurvivesADeletedWorkspace(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := migratedSchema(ctx, t)
	seed(ctx, t, dsn)

	clock := testClock()
	m := openMeter(ctx, t, dsn, clock)

	if err := exec(ctx, t, dsn, "DELETE FROM workspaces WHERE id = 'ws_bob'"); err != nil {
		t.Fatalf("delete workspace: %v", err)
	}

	m.RecordAccepted("ws_alice", "key_alice", 2, 0)
	m.RecordAccepted("ws_bob", "key_bob", 5, 0)
	if err := m.Flush(ctx); err == nil {
		t.Fatal("the flush committed rows for a workspace that no longer exists")
	}

	m.RecordAccepted("ws_alice", "key_alice", 3, 0)
	if err := m.Flush(ctx); err != nil {
		t.Fatalf("the flusher stayed wedged behind the rejected snapshot: %v", err)
	}
	if spans, _, _ := ledgerRow(ctx, t, dsn, "ws_alice"); spans != 3 {
		t.Errorf("ws_alice ledger = %d spans, want the 3 recorded after the rejected flush", spans)
	}
}

// windowSum totals a key's window buckets — what two concurrent flushers must
// have added up to.
func windowSum(ctx context.Context, t *testing.T, dsn, keyID string) int64 {
	t.Helper()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)

	var total int64
	if err := conn.QueryRow(ctx,
		"SELECT coalesce(sum(accepted), 0) FROM api_key_health_windows WHERE key_id = $1",
		keyID).Scan(&total); err != nil {
		t.Fatalf("sum the window buckets: %v", err)
	}
	return total
}
