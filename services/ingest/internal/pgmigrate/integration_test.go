package pgmigrate

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/pgmigrations"
)

// These tests run against a real Postgres. A fake server would only be a claim
// about the fake, and the properties under test — transactional DDL, a unique
// version key, a foreign key that cascades — are the server's, not ours.
//
// The default is the compose stack from deploy/compose. Without it, one
// container is enough and is what CI runs too:
//
//	docker run --rm -d --name obstack-pgmigrate-test \
//	  -e POSTGRES_USER=obstack -e POSTGRES_PASSWORD=obstack_postgres_dev \
//	  -e POSTGRES_DB=obstack -p 127.0.0.1:5432:5432 postgres:17.11
//
// Fixing values: image postgres:17.11 (the exact pin compose and the chart use),
// role/password/database obstack/obstack_postgres_dev/obstack, published on
// 127.0.0.1:5432 — which together are the default DSN below.
const defaultDSN = "postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack"

func testDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_POSTGRES_DSN"); dsn != "" {
		return dsn
	}
	return defaultDSN
}

// requirePostgres skips rather than fails when no server is reachable: a laptop
// without the compose stack up should not report a broken migrator.
func requirePostgres(t *testing.T) context.Context {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)

	pingCtx, cancelPing := context.WithTimeout(ctx, 5*time.Second)
	defer cancelPing()
	conn, err := pgx.Connect(pingCtx, testDSN())
	if err != nil {
		t.Skipf("no Postgres at %s (%v); start deploy/compose or the documented postgres:17.11 container to run the pgmigrate integration tests", testDSN(), err)
	}
	conn.Close(ctx)
	return ctx
}

// freshSchema hands a test its own empty schema and a DSN scoped to it, so
// "fresh boot" means what it says: no schema_migrations, no obstack tables,
// nothing a previous run or a developer's dev database left behind. A schema
// rather than a database because the migration SQL qualifies nothing —
// search_path is the entire isolation mechanism — and because dropping one does
// not have to wait for every other connection to let go of it.
func freshSchema(ctx context.Context, t *testing.T) string {
	t.Helper()

	name := fmt.Sprintf("pgmigrate_test_%d", time.Now().UnixNano())
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

	// search_path travels as a startup runtime parameter, so every connection
	// this DSN opens — the runner's included — lands in the new schema.
	u, err := url.Parse(testDSN())
	if err != nil {
		t.Fatalf("test DSN must be a postgres:// URL for schema scoping: %v", err)
	}
	q := u.Query()
	q.Set("search_path", name)
	u.RawQuery = q.Encode()
	return u.String()
}

// exec and queryBool run a statement of the test's own against the scoped DSN,
// so an assertion about what the migration built is made through the same
// search_path the migration used.
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

func queryBool(ctx context.Context, t *testing.T, dsn, sql string, args ...any) bool {
	t.Helper()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)

	var got bool
	if err := conn.QueryRow(ctx, sql, args...).Scan(&got); err != nil {
		t.Fatalf("query %q: %v", sql, err)
	}
	return got
}

func tableExists(ctx context.Context, t *testing.T, dsn, table string) bool {
	t.Helper()
	// to_regclass resolves through search_path and returns NULL rather than
	// raising when the relation is absent, which is the question being asked.
	return queryBool(ctx, t, dsn, "SELECT to_regclass($1) IS NOT NULL", table)
}

func appliedInDB(ctx context.Context, t *testing.T, dsn, version string) bool {
	t.Helper()
	return queryBool(ctx, t, dsn, "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)", version)
}

// A first boot against a database with nothing in it: the whole embedded set
// applies, the tables are really there, and the second boot the package doc
// promises is a no-op is asserted rather than described.
func TestFreshBootAppliesAndSecondBootIsANoOp(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := freshSchema(ctx, t)

	if tableExists(ctx, t, dsn, "schema_migrations") {
		t.Fatal("a fresh schema already has schema_migrations — the isolation is not isolating")
	}
	todo, err := Pending(ctx, dsn, pgmigrations.FS)
	if err != nil {
		t.Fatalf("Pending before the first run: %v", err)
	}
	want := embeddedVersions(t)
	if !reflect.DeepEqual(todo, want) {
		t.Errorf("Pending on a fresh database = %v, want the whole set %v", todo, want)
	}
	// Verifying must not apply, least of all the registry it reads.
	if tableExists(ctx, t, dsn, "schema_migrations") {
		t.Error("Pending created schema_migrations — the verify path has to stay read-only")
	}

	ran, err := Run(ctx, dsn, pgmigrations.FS)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !reflect.DeepEqual(ran, want) {
		t.Errorf("Run applied %v, want %v", ran, want)
	}
	for _, table := range []string{"workspaces", "saved_views"} {
		if !tableExists(ctx, t, dsn, table) {
			t.Errorf("%s is missing after a fresh boot", table)
		}
	}

	if todo, err := Pending(ctx, dsn, pgmigrations.FS); err != nil || len(todo) != 0 {
		t.Errorf("Pending after Run = %v, %v; want none, nil", todo, err)
	}
	ran, err = Run(ctx, dsn, pgmigrations.FS)
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}
	if len(ran) != 0 {
		t.Errorf("second Run applied %v, want nothing", ran)
	}
}

// A version the binary carries and the server has not recorded is exactly the
// case a verifying pod exists to catch, so Pending is asked about one directly.
func TestPendingReportsUnappliedVersions(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := freshSchema(ctx, t)

	if _, err := Run(ctx, dsn, pgmigrations.FS); err != nil {
		t.Fatalf("Run: %v", err)
	}

	fsys := fstest.MapFS{
		"0001_workspaces.sql":       {Data: []byte("SELECT 1")},
		"9998_not_applied.sql":      {Data: []byte("SELECT 1")},
		"9999_also_not_applied.sql": {Data: []byte("SELECT 1")},
	}
	todo, err := Pending(ctx, dsn, fsys)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	// 0001_workspaces is applied by the Run above; the two invented ones are
	// not, and they come back in the order Run would apply them.
	want := []string{"9998_not_applied", "9999_also_not_applied"}
	if !reflect.DeepEqual(todo, want) {
		t.Errorf("Pending = %v, want %v", todo, want)
	}

	if todo, err := Pending(ctx, dsn, fstest.MapFS{}); err != nil || len(todo) != 0 {
		t.Errorf("Pending over an empty FS = %v, %v; want none, nil", todo, err)
	}
}

// A migration that fails partway is the case the whole transactional shape is
// for: the error names the file, the work that file had already done is gone,
// the files before it stay applied, and the next run has the same job to do it
// had before. The second statement below is valid SQL that fails at execution
// rather than a syntax error, so the failure really is mid-file — the server
// parses a simple-query string before it runs any of it.
func TestAFailedMigrationReportsAndLeavesNothingBehind(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := freshSchema(ctx, t)

	fsys := fstest.MapFS{
		"0001_first.sql": {Data: []byte("CREATE TABLE partial_first (id TEXT PRIMARY KEY);")},
		"0002_broken.sql": {Data: []byte(
			"CREATE TABLE partial_second (id TEXT PRIMARY KEY);\n" +
				"CREATE TABLE partial_second (id TEXT PRIMARY KEY);")},
	}

	ran, err := Run(ctx, dsn, fsys)
	if err == nil {
		t.Fatal("Run reported success over a migration that could not apply")
	}
	if !strings.Contains(err.Error(), "0002_broken.sql") {
		t.Errorf("error = %v, want it to name the file that stopped it", err)
	}
	if ran != nil {
		t.Errorf("Run returned %v alongside an error; a failed run reports the failure, not a partial success", ran)
	}

	if !tableExists(ctx, t, dsn, "partial_first") || !appliedInDB(ctx, t, dsn, "0001_first") {
		t.Error("the migration before the failure was rolled back with it — each file commits on its own")
	}
	if tableExists(ctx, t, dsn, "partial_second") {
		t.Error("the failed migration left its first statement behind; the file must apply whole or not at all")
	}
	if appliedInDB(ctx, t, dsn, "0002_broken") {
		t.Error("the failed migration was recorded as applied")
	}

	todo, err := Pending(ctx, dsn, fsys)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if !reflect.DeepEqual(todo, []string{"0002_broken"}) {
		t.Errorf("Pending after the failure = %v, want the failed version still to do", todo)
	}
}

// The DDL is the artifact, so its contract is asserted against the server that
// enforces it: the D47/D116 identity of a saved view (one name per surface per
// workspace), the surface CHECK, and the in-set foreign key that makes a
// workspace's views disappear with it.
func TestSavedViewsEnforceTheirIdentityContract(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := freshSchema(ctx, t)

	if _, err := Run(ctx, dsn, pgmigrations.FS); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if err := exec(ctx, t, dsn,
		"INSERT INTO workspaces (id, org_id) VALUES ('ws_a', 'org_a'), ('ws_b', 'org_a')"); err != nil {
		t.Fatalf("insert workspaces: %v", err)
	}

	insert := `INSERT INTO saved_views (id, workspace_id, surface, name, filters) VALUES ($1, $2, $3, $4, $5)`
	if err := exec(ctx, t, dsn, insert, "sv_1", "ws_a", "traces", "errors", `{"status":"error"}`); err != nil {
		t.Fatalf("insert saved view: %v", err)
	}

	t.Run("a name is unique per workspace and surface", func(t *testing.T) {
		if err := exec(ctx, t, dsn, insert, "sv_2", "ws_a", "traces", "errors", `{"status":"error"}`); err == nil {
			t.Error("a second view took the same name on the same surface; save-over-name has no unique key to upsert on")
		}
		// The same name on the other surface, and in the other workspace, are
		// different views — the scoping is what the uniqueness is about.
		if err := exec(ctx, t, dsn, insert, "sv_3", "ws_a", "logs", "errors", `{"severity":"error"}`); err != nil {
			t.Errorf("the same name on another surface was refused: %v", err)
		}
		if err := exec(ctx, t, dsn, insert, "sv_4", "ws_b", "traces", "errors", `{"status":"error"}`); err != nil {
			t.Errorf("the same name in another workspace was refused: %v", err)
		}
	})

	t.Run("surface is checked, not free text", func(t *testing.T) {
		if err := exec(ctx, t, dsn, insert, "sv_5", "ws_a", "metrics", "errors", `{}`); err == nil {
			t.Error("a view was saved against a surface that does not exist")
		}
	})

	t.Run("a view cannot outlive its workspace", func(t *testing.T) {
		if err := exec(ctx, t, dsn, insert, "sv_6", "ws_missing", "traces", "errors", `{}`); err == nil {
			t.Error("a view was saved against a workspace that does not exist")
		}
		if err := exec(ctx, t, dsn, "DELETE FROM workspaces WHERE id = 'ws_b'"); err != nil {
			t.Fatalf("delete workspace: %v", err)
		}
		if queryBool(ctx, t, dsn, "SELECT EXISTS (SELECT 1 FROM saved_views WHERE workspace_id = 'ws_b')") {
			t.Error("the deleted workspace's views survived it")
		}
		if !queryBool(ctx, t, dsn, "SELECT EXISTS (SELECT 1 FROM saved_views WHERE workspace_id = 'ws_a')") {
			t.Error("the cascade took the other workspace's views too")
		}
	})
}
