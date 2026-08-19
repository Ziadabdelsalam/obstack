package keystore

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pgmigrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/pgmigrations"
)

// These tests run against a real Postgres, through the real query, against the
// real migration — the row the web app writes and the row ingest reads are the
// same row, and only a server can say so. store_test.go proves the cache
// semantics with no database; this file proves the half a fake cannot.
//
// The default is the compose stack from deploy/compose. Without it, one
// container is enough and is what CI runs too:
//
//	docker run --rm -d --name obstack-keystore-test \
//	  -e POSTGRES_USER=obstack -e POSTGRES_PASSWORD=obstack_postgres_dev \
//	  -e POSTGRES_DB=obstack -p 127.0.0.1:5432:5432 postgres:17.11
//
// Fixing values: image postgres:17.11 (the pin compose and the chart use),
// role/password/database obstack/obstack_postgres_dev/obstack on
// 127.0.0.1:5432 — together the default DSN below, overridden by
// OBSTACK_TEST_POSTGRES_DSN.
const defaultDSN = "postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack"

func testDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_POSTGRES_DSN"); dsn != "" {
		return dsn
	}
	return defaultDSN
}

// requirePostgres skips rather than fails when no server is reachable: a laptop
// without the compose stack up should not report a broken keystore.
func requirePostgres(t *testing.T) context.Context {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)

	pingCtx, cancelPing := context.WithTimeout(ctx, 5*time.Second)
	defer cancelPing()
	conn, err := pgx.Connect(pingCtx, testDSN())
	if err != nil {
		t.Skipf("no Postgres at %s (%v); start deploy/compose or the documented postgres:17.11 container to run the keystore integration tests", testDSN(), err)
	}
	conn.Close(ctx)
	return ctx
}

// migratedSchema hands a test its own schema with the whole embedded set applied
// — including 0004's continuity seed — and a DSN scoped to it, the way
// internal/pgmigrate's own tests isolate. search_path travels as a startup
// parameter, so every connection the pool opens lands in that schema.
func migratedSchema(ctx context.Context, t *testing.T) string {
	t.Helper()

	name := fmt.Sprintf("keystore_test_%d", time.Now().UnixNano())
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

// openStore is Open plus a clock the test can move, since the TTL it has to
// cross is 30 s of real time.
func openStore(ctx context.Context, t *testing.T, dsn string) (*Store, *fakeClock) {
	t.Helper()

	s, err := Open(ctx, dsn)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(s.Close)

	clock := &fakeClock{t: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)}
	s.now = clock.now
	return s, clock
}

// issueKey writes a key the way the web app does: a token in the issued format,
// stored as its SHA-256 and never itself. The token is returned; the row cannot
// reproduce it.
func issueKey(ctx context.Context, t *testing.T, dsn, id, workspaceID, token string) {
	t.Helper()

	err := exec(ctx, t, dsn,
		"INSERT INTO api_keys (id, workspace_id, name, prefix, token_hash) VALUES ($1, $2, $3, $4, $5)",
		id, workspaceID, "issued in a test", token[:12], hashToken(token))
	if err != nil {
		t.Fatalf("insert api key %s: %v", id, err)
	}
}

const issuedToken = "ok_live_1f4a9c0b7e2d6a58c3b1f0e9d8c7b6a5f4e3d2c1b0a99887766554433221100"

// The wire path end to end, in the shape D142(1) names: a token in the issued
// format, hashed and inserted the way the web app inserts it, resolves through
// the keystore to its own workspace and to no other.
func TestIssuedKeyResolvesToItsWorkspace(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := migratedSchema(ctx, t)

	if err := exec(ctx, t, dsn,
		"INSERT INTO workspaces (id, org_id) VALUES ('ws_alice', 'org_alice'), ('ws_bob', 'org_bob')"); err != nil {
		t.Fatalf("insert workspaces: %v", err)
	}
	issueKey(ctx, t, dsn, "key_alice", "ws_alice", issuedToken)
	const bobsToken = "ok_live_00112233445566778899aabbccddeeff00112233445566778899aabbccdd"
	issueKey(ctx, t, dsn, "key_bob", "ws_bob", bobsToken)

	s, _ := openStore(ctx, t, dsn)

	mustResolve(t, s, issuedToken, "ws_alice")
	mustResolve(t, s, bobsToken, "ws_bob")
	mustRefuse(t, s, "ok_live_"+strings.Repeat("f", 64))

	// The continuity row from 0004: the credential the collector and every
	// signed harness send, resolving through the same code, with no dev-key
	// branch anywhere for it to take.
	mustResolve(t, s, "ok_dev_local", "ws_demo")

	// Shown-once, from ingest's side: the stored row does not contain the token.
	var stored string
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)
	if err := conn.QueryRow(ctx, "SELECT concat(prefix, token_hash) FROM api_keys WHERE id = 'key_alice'").Scan(&stored); err != nil {
		t.Fatalf("read the stored key: %v", err)
	}
	if strings.Contains(stored, issuedToken) {
		t.Error("the stored row carries the token itself; a database dump would be a credential dump")
	}
}

// Revocation is honored within keyCacheTTL and no sooner — the cost of not
// making Postgres a per-request dependency, stated here as a test rather than
// left for an operator to discover.
func TestRevokedKeyIsRefusedOnceTheCachedAnswerExpires(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := migratedSchema(ctx, t)

	if err := exec(ctx, t, dsn, "INSERT INTO workspaces (id, org_id) VALUES ('ws_alice', 'org_alice')"); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	issueKey(ctx, t, dsn, "key_alice", "ws_alice", issuedToken)

	s, clock := openStore(ctx, t, dsn)
	mustResolve(t, s, issuedToken, "ws_alice")

	if err := exec(ctx, t, dsn, "UPDATE api_keys SET revoked_at = now() WHERE id = 'key_alice'"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	mustResolve(t, s, issuedToken, "ws_alice") // inside the window, by design

	clock.advance(keyCacheTTL + time.Second)
	mustRefuse(t, s, issuedToken)

	// Indistinguishable from an unknown key, which is the point of resolving
	// revocation in the WHERE clause rather than in a branch (D6).
	revoked, err := s.Workspace(issuedToken)
	unknown, unknownErr := s.Workspace("ok_live_" + strings.Repeat("e", 64))
	if revoked != unknown || !errors.Is(err, auth.ErrUnauthorized) || !errors.Is(unknownErr, auth.ErrUnauthorized) {
		t.Errorf("revoked = %q/%v, unknown = %q/%v; the two must be one answer", revoked, err, unknown, unknownErr)
	}
}

// Fail-static against the real thing: Postgres goes away, and the keys it
// already answered for keep working. An ingest that 401s a paying customer
// because our control plane is down has made our outage theirs (PRD §9).
func TestPostgresDownServesCachedEntriesStale(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := migratedSchema(ctx, t)

	if err := exec(ctx, t, dsn, "INSERT INTO workspaces (id, org_id) VALUES ('ws_alice', 'org_alice')"); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	issueKey(ctx, t, dsn, "key_alice", "ws_alice", issuedToken)

	s, clock := openStore(ctx, t, dsn)
	mustResolve(t, s, issuedToken, "ws_alice")
	mustResolve(t, s, "ok_dev_local", "ws_demo")

	// Closing the pool is this process losing Postgres: every query from here on
	// fails, exactly as it does when the server is gone.
	s.pool.Close()
	clock.advance(keyCacheTTL + time.Second)

	mustResolve(t, s, issuedToken, "ws_alice")
	mustResolve(t, s, issuedToken, "ws_alice")
	mustResolve(t, s, "ok_dev_local", "ws_demo")

	// The other half of the honesty: unknown keys are still refused, and a key
	// this process never resolved gets nothing — a cold cache plus a dead
	// Postgres is 401s until Postgres returns.
	mustRefuse(t, s, "ok_live_"+strings.Repeat("d", 64))
}

// The DDL is the artifact, so its contract is asserted against the server that
// enforces it: one row per token hash, no key without a workspace, and keys that
// do not outlive the workspace they write into.
func TestAPIKeysDDLContract(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := migratedSchema(ctx, t)

	if err := exec(ctx, t, dsn, "INSERT INTO workspaces (id, org_id) VALUES ('ws_alice', 'org_alice')"); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	issueKey(ctx, t, dsn, "key_alice", "ws_alice", issuedToken)

	insert := "INSERT INTO api_keys (id, workspace_id, name, prefix, token_hash) VALUES ($1, $2, $3, $4, $5)"
	if err := exec(ctx, t, dsn, insert, "key_dup", "ws_alice", "dup", "ok_live_1f4a", hashToken(issuedToken)); err == nil {
		t.Error("a second row took the same token_hash; the lookup would have to disambiguate a credential")
	}
	if err := exec(ctx, t, dsn, insert, "key_orphan", "ws_missing", "orphan", "ok_live_0000", hashToken("ok_live_orphan")); err == nil {
		t.Error("a key was issued against a workspace that does not exist")
	}

	if err := exec(ctx, t, dsn, "DELETE FROM workspaces WHERE id = 'ws_alice'"); err != nil {
		t.Fatalf("delete workspace: %v", err)
	}
	s, _ := openStore(ctx, t, dsn)
	mustRefuse(t, s, issuedToken)

	// The seed is one workspace and one key, and the migration is what put them
	// there — the collector's credential is not something a deployment has to
	// remember to create.
	var keys int
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)
	if err := conn.QueryRow(ctx,
		"SELECT count(*) FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id WHERE w.id = 'ws_demo' AND w.org_id = 'org_demo'").Scan(&keys); err != nil {
		t.Fatalf("count the seeded keys: %v", err)
	}
	if keys != 1 {
		t.Errorf("the seed left %d keys on ws_demo, want exactly the one continuity row", keys)
	}
}
