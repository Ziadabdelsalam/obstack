package changes

// The store is a real INSERT against a real Postgres: the dedupe path is the
// partial UNIQUE index doing its work (D496), and the tenancy claim — the
// same external_id in two workspaces is two rows — is a property of that
// index, not of Go. Defaults are the compose stack; the DSN overrides for
// CI; without a reachable server the tests skip, the standing convention.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"regexp"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
)

const defaultPostgresDSN = "postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack"

func pgTestDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_POSTGRES_DSN"); dsn != "" {
		return dsn
	}
	return defaultPostgresDSN
}

func connectPostgres(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, pgTestDSN())
	if err != nil {
		t.Fatalf("open postgres: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("no Postgres at %s (%v); start deploy/compose to run the changes store tests", pgTestDSN(), err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool
}

func randomHex(t *testing.T) string {
	t.Helper()
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b[:])
}

// seedWorkspace creates a workspace with one api key and returns the identity
// a request through that key would resolve to. The workspace row's deletion
// cascades everything the test wrote.
func seedWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool) auth.Identity {
	t.Helper()
	suffix := randomHex(t)
	ws, key := "ws_chg_"+suffix, "key_chg_"+suffix
	if _, err := pool.Exec(ctx, `INSERT INTO workspaces (id, org_id) VALUES ($1, $2)`, ws, "org_chg_"+suffix); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, ws)
	})
	if _, err := pool.Exec(ctx, `INSERT INTO api_keys (id, workspace_id, name, prefix, token_hash) VALUES ($1, $2, 'test', 'ok_test_', $3)`,
		key, ws, randomHex(t)+randomHex(t)); err != nil {
		t.Fatalf("seed key: %v", err)
	}
	return auth.Identity{WorkspaceID: ws, KeyID: key}
}

var idShape = regexp.MustCompile(`^chg_[0-9a-f]{16}$`)

func TestPGStoreInsertsAndDeduplicates(t *testing.T) {
	ctx, pool := connectPostgres(t)
	store := NewPGStore(pool)
	alice := seedWorkspace(t, ctx, pool)

	at := time.Date(2026, 9, 1, 8, 30, 0, 0, time.UTC)
	ev := Event{
		Kind: "deploy", Title: "deploy 1", Detail: "first", Who: "ziad",
		Service: str("checkout"), Ref: str("abc1234"), Source: str("github-actions"),
		ExternalID: str("run:1"), Link: &Link{Label: "run", Href: "https://ci.example/1"}, At: at,
	}
	id, dedup, err := store.Insert(ctx, alice, ev)
	if err != nil || dedup {
		t.Fatalf("first insert: id=%q dedup=%v err=%v", id, dedup, err)
	}
	if !idShape.MatchString(id) {
		t.Errorf("id = %q, want chg_ + 16 hex", id)
	}

	var gotWS, gotKey, gotKind, gotTitle, gotService, gotLabel, gotHref, gotExt string
	var gotAt time.Time
	err = pool.QueryRow(ctx, `SELECT workspace_id, key_id, kind, title, service, link_label, link_href, external_id, at
		FROM change_events WHERE id = $1`, id).Scan(&gotWS, &gotKey, &gotKind, &gotTitle, &gotService, &gotLabel, &gotHref, &gotExt, &gotAt)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if gotWS != alice.WorkspaceID || gotKey != alice.KeyID || gotKind != "deploy" || gotTitle != "deploy 1" ||
		gotService != "checkout" || gotLabel != "run" || gotHref != "https://ci.example/1" || gotExt != "run:1" || !gotAt.Equal(at) {
		t.Errorf("row = %q %q %q %q %q %q %q %q %v", gotWS, gotKey, gotKind, gotTitle, gotService, gotLabel, gotHref, gotExt, gotAt)
	}

	// The retry: same external_id, a different body. First write wins; the
	// second body is nowhere.
	again := ev
	again.Title = "deploy 1 AGAIN"
	id2, dedup2, err := store.Insert(ctx, alice, again)
	if err != nil || !dedup2 || id2 != id {
		t.Fatalf("duplicate insert: id=%q (want %q) dedup=%v err=%v", id2, id, dedup2, err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM change_events WHERE workspace_id = $1`, alice.WorkspaceID).Scan(&n); err != nil || n != 1 {
		t.Errorf("rows for alice = %d (err %v), want 1", n, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM change_events WHERE title = 'deploy 1 AGAIN'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("the second body landed: %d rows (err %v)", n, err)
	}

	// Tenancy: the same external_id in another workspace is another row.
	bob := seedWorkspace(t, ctx, pool)
	id3, dedup3, err := store.Insert(ctx, bob, ev)
	if err != nil || dedup3 || id3 == id {
		t.Fatalf("bob's insert with alice's external_id: id=%q dedup=%v err=%v", id3, dedup3, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM change_events WHERE workspace_id = $1`, alice.WorkspaceID).Scan(&n); err != nil || n != 1 {
		t.Errorf("bob's post changed alice's rows: %d", n)
	}

	// Without an external_id every post is a new row.
	plain := Event{Kind: "config", Title: "no handle", At: at}
	idA, _, errA := store.Insert(ctx, alice, plain)
	idB, _, errB := store.Insert(ctx, alice, plain)
	if errA != nil || errB != nil || idA == idB {
		t.Errorf("two handle-less posts: %q %q (%v %v)", idA, idB, errA, errB)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM change_events WHERE workspace_id = $1 AND external_id IS NULL`, alice.WorkspaceID).Scan(&n); err != nil || n != 2 {
		t.Errorf("handle-less rows = %d, want 2", n)
	}
}

func TestPGStoreRefusesACredentialThatNoLongerExists(t *testing.T) {
	ctx, pool := connectPostgres(t)
	store := NewPGStore(pool)
	alice := seedWorkspace(t, ctx, pool)
	gone := auth.Identity{WorkspaceID: alice.WorkspaceID, KeyID: "key_missing_" + randomHex(t)}
	_, _, err := store.Insert(ctx, gone, Event{Kind: "infra", Title: "x", At: testNow})
	if !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("err = %v, want ErrUnknownKey", err)
	}
}

func TestPGStoreReportsStorageFailure(t *testing.T) {
	ctx, _ := connectPostgres(t)
	pool, err := pgxpool.New(ctx, pgTestDSN())
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()
	store := NewPGStore(pool)
	_, _, err = store.Insert(ctx, auth.Identity{WorkspaceID: "ws_demo", KeyID: "key_dev_local"}, Event{Kind: "infra", Title: "x", At: testNow})
	if !errors.Is(err, ErrStorage) {
		t.Fatalf("err = %v, want ErrStorage", err)
	}
}
