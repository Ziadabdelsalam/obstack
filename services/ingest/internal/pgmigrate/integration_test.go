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

func queryInt64(ctx context.Context, t *testing.T, dsn, sql string, args ...any) int64 {
	t.Helper()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)

	var got int64
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

// The plan catalog is the one definition of a quota (D163): Go enforces from it
// and TypeScript displays from it, so the numbers a fresh boot lands are pricing
// copy and not a fixture. Applying twice is asserted here as well as in the
// no-op test above, because a seed is the one kind of statement whose second
// application would be visible as data rather than as an error.
func TestThePlanCatalogIsSeededOnceWithTheRuledNumbers(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := freshSchema(ctx, t)

	if _, err := Run(ctx, dsn, pgmigrations.FS); err != nil {
		t.Fatalf("Run: %v", err)
	}
	for _, table := range []string{"usage_ledger", "api_key_health", "pricing_overrides", "plans", "workspace_plans"} {
		if !tableExists(ctx, t, dsn, table) {
			t.Errorf("%s is missing after a fresh boot", table)
		}
	}

	// free: 50k events a month, 7 days, $0. pro: 1M, 30 days, $49.
	for _, want := range []struct {
		id        string
		name      string
		quota     int64
		retention int64
		price     string
	}{
		{"free", "Free", 50_000, 7, "0.00"},
		{"pro", "Pro", 1_000_000, 30, "49.00"},
	} {
		if !queryBool(ctx, t, dsn,
			"SELECT EXISTS (SELECT 1 FROM plans WHERE id = $1 AND name = $2 AND event_quota = $3 AND retention_days = $4 AND price_usd_month::text = $5)",
			want.id, want.name, want.quota, want.retention, want.price) {
			t.Errorf("the %s plan row is not (%s, %d events, %d days, $%s) — the catalog is the pricing copy",
				want.id, want.name, want.quota, want.retention, want.price)
		}
	}

	if _, err := Run(ctx, dsn, pgmigrations.FS); err != nil {
		t.Fatalf("second Run: %v", err)
	}
	if got := queryInt64(ctx, t, dsn, "SELECT count(*) FROM plans"); got != 2 {
		t.Errorf("plans holds %d rows after two runs, want the 2 seeded ones — a re-applied seed duplicates the catalog", got)
	}
}

// The ledger's contract is the UPSERT-add of record (D162): every writer adds
// into an hour bucket and none of them sets, which is what makes N ingest
// replicas counting the same workspace correct without coordinating. The
// statement below is the one the flusher issues, asserted against the server
// that has to accept it.
func TestTheUsageLedgerAccumulatesPerWorkspaceHour(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := freshSchema(ctx, t)

	if _, err := Run(ctx, dsn, pgmigrations.FS); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if err := exec(ctx, t, dsn,
		"INSERT INTO workspaces (id, org_id) VALUES ('ws_a', 'org_a'), ('ws_b', 'org_a')"); err != nil {
		t.Fatalf("insert workspaces: %v", err)
	}

	const upsert = `INSERT INTO usage_ledger (workspace_id, period_start, spans, logs)
VALUES ($1, $2, $3, $4)
ON CONFLICT (workspace_id, period_start) DO UPDATE
  SET spans = usage_ledger.spans + EXCLUDED.spans,
      logs = usage_ledger.logs + EXCLUDED.logs,
      updated_at = now()`

	hour := time.Date(2026, 8, 19, 13, 0, 0, 0, time.UTC)
	next := hour.Add(time.Hour)
	for _, args := range [][]any{
		{"ws_a", hour, int64(10), int64(3)},
		{"ws_a", hour, int64(5), int64(1)},
		{"ws_a", next, int64(100), int64(0)},
		{"ws_b", hour, int64(7), int64(7)},
	} {
		if err := exec(ctx, t, dsn, upsert, args...); err != nil {
			t.Fatalf("ledger upsert %v: %v", args, err)
		}
	}

	if got := queryInt64(ctx, t, dsn,
		"SELECT spans + logs FROM usage_ledger WHERE workspace_id = 'ws_a' AND period_start = $1", hour); got != 19 {
		t.Errorf("the repeated bucket holds %d events, want 19 — the conflict clause set instead of adding", got)
	}
	// The month sum is the D163 quota definition, and it is the same number the
	// tab and the banner show; a bucket per hour is an implementation detail of
	// the reporter's idempotency, never a second unit of account.
	if got := queryInt64(ctx, t, dsn,
		"SELECT COALESCE(SUM(spans + logs), 0) FROM usage_ledger WHERE workspace_id = 'ws_a' AND period_start >= date_trunc('month', $1::timestamptz)", hour); got != 119 {
		t.Errorf("ws_a's month sums to %d, want 119", got)
	}
	if got := queryInt64(ctx, t, dsn,
		"SELECT COALESCE(SUM(spans + logs), 0) FROM usage_ledger WHERE workspace_id = 'ws_b'"); got != 14 {
		t.Errorf("ws_b sums to %d, want 14 — the bucket key is not scoping by workspace", got)
	}

	if err := exec(ctx, t, dsn, "DELETE FROM workspaces WHERE id = 'ws_b'"); err != nil {
		t.Fatalf("delete workspace: %v", err)
	}
	if queryBool(ctx, t, dsn, "SELECT EXISTS (SELECT 1 FROM usage_ledger WHERE workspace_id = 'ws_b')") {
		t.Error("the deleted workspace's usage survived it")
	}
}

// A workspace with no workspace_plans row is on the free plan (D163) — that is
// the whole reason signup needs no billing write and no backfill exists. The
// join below is the resolution every runtime performs; if it stopped answering
// for a workspace that has never touched billing, quota would be undefined for
// almost every account we have.
func TestAWorkspaceWithoutAPlanRowResolvesFree(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := freshSchema(ctx, t)

	if _, err := Run(ctx, dsn, pgmigrations.FS); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if err := exec(ctx, t, dsn,
		"INSERT INTO workspaces (id, org_id) VALUES ('ws_free', 'org_a'), ('ws_paid', 'org_a')"); err != nil {
		t.Fatalf("insert workspaces: %v", err)
	}
	if err := exec(ctx, t, dsn,
		"INSERT INTO workspace_plans (workspace_id, plan_id, polar_customer_id) VALUES ('ws_paid', 'pro', 'cus_x')"); err != nil {
		t.Fatalf("insert workspace_plans: %v", err)
	}

	const resolve = `SELECT p.event_quota
FROM workspaces w
LEFT JOIN workspace_plans wp ON wp.workspace_id = w.id
JOIN plans p ON p.id = COALESCE(wp.plan_id, 'free')
WHERE w.id = $1`
	if got := queryInt64(ctx, t, dsn, resolve, "ws_free"); got != 50_000 {
		t.Errorf("a workspace with no plan row resolves a quota of %d, want the free plan's 50000", got)
	}
	if got := queryInt64(ctx, t, dsn, resolve, "ws_paid"); got != 1_000_000 {
		t.Errorf("the pro workspace resolves a quota of %d, want 1000000", got)
	}

	t.Run("a plan the catalog does not define is unrepresentable", func(t *testing.T) {
		if err := exec(ctx, t, dsn,
			"INSERT INTO workspace_plans (workspace_id, plan_id) VALUES ('ws_free', 'enterprise')"); err == nil {
			t.Error("a workspace was put on a plan with no catalog row — the quota it resolves would be no row at all")
		}
	})

	t.Run("a plan row cannot outlive its workspace", func(t *testing.T) {
		if err := exec(ctx, t, dsn, "DELETE FROM workspaces WHERE id = 'ws_paid'"); err != nil {
			t.Fatalf("delete workspace: %v", err)
		}
		if queryBool(ctx, t, dsn, "SELECT EXISTS (SELECT 1 FROM workspace_plans WHERE workspace_id = 'ws_paid')") {
			t.Error("the deleted workspace kept its plan row, and with it a polar customer id nothing can reach")
		}
	})
}

// Health is one row per key (D100) and overrides are one rate pair per match
// (D108); both are UPSERT targets, so both need the key the writer conflicts on
// to be the identity the product means.
func TestHealthAndOverrideRowsCarryTheirIdentity(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := freshSchema(ctx, t)

	if _, err := Run(ctx, dsn, pgmigrations.FS); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if err := exec(ctx, t, dsn, "INSERT INTO workspaces (id, org_id) VALUES ('ws_a', 'org_a')"); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	if err := exec(ctx, t, dsn,
		"INSERT INTO api_keys (id, workspace_id, name, prefix, token_hash) VALUES ('key_a', 'ws_a', 'a', 'ok_a', 'hash_a')"); err != nil {
		t.Fatalf("insert api key: %v", err)
	}

	t.Run("health accumulates per key and states its own as-of", func(t *testing.T) {
		const upsert = `INSERT INTO api_key_health (key_id, workspace_id, accepted, dropped_quota, last_event_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (key_id) DO UPDATE
  SET accepted = api_key_health.accepted + EXCLUDED.accepted,
      dropped_quota = api_key_health.dropped_quota + EXCLUDED.dropped_quota,
      last_event_at = GREATEST(api_key_health.last_event_at, EXCLUDED.last_event_at),
      updated_at = now()`
		seen := time.Date(2026, 8, 19, 13, 30, 0, 0, time.UTC)
		if err := exec(ctx, t, dsn, upsert, "key_a", "ws_a", int64(4), int64(0), seen); err != nil {
			t.Fatalf("health upsert: %v", err)
		}
		if err := exec(ctx, t, dsn, upsert, "key_a", "ws_a", int64(6), int64(2), seen.Add(time.Minute)); err != nil {
			t.Fatalf("health upsert: %v", err)
		}
		if got := queryInt64(ctx, t, dsn, "SELECT accepted FROM api_key_health WHERE key_id = 'key_a'"); got != 10 {
			t.Errorf("accepted = %d after two flushes of 4 and 6, want 10", got)
		}
		if got := queryInt64(ctx, t, dsn, "SELECT dropped_quota FROM api_key_health WHERE key_id = 'key_a'"); got != 2 {
			t.Errorf("dropped_quota = %d, want 2 — the quota drops the banner explains are read from here", got)
		}
		if err := exec(ctx, t, dsn,
			"INSERT INTO api_key_health (key_id, workspace_id) VALUES ('key_a', 'ws_a')"); err == nil {
			t.Error("a second health row was accepted for one key; the UPSERT has no single row to conflict on")
		}
	})

	// A key that has authenticated but never carried an accepted record has no
	// last event, and "never" must reach the tab as absence rather than as the
	// epoch — which is why last_event_at is the one nullable count here.
	t.Run("a key with no accepted record has no last event", func(t *testing.T) {
		if err := exec(ctx, t, dsn,
			"INSERT INTO api_keys (id, workspace_id, name, prefix, token_hash) VALUES ('key_b', 'ws_a', 'b', 'ok_b', 'hash_b')"); err != nil {
			t.Fatalf("insert api key: %v", err)
		}
		if err := exec(ctx, t, dsn,
			"INSERT INTO api_key_health (key_id, workspace_id, dropped_decode) VALUES ('key_b', 'ws_a', 3)"); err != nil {
			t.Fatalf("insert health row: %v", err)
		}
		if !queryBool(ctx, t, dsn,
			"SELECT last_event_at IS NULL AND accepted = 0 FROM api_key_health WHERE key_id = 'key_b'") {
			t.Error("a key that has never carried a record reports a last event or a non-zero accepted count")
		}
	})

	t.Run("a key's health dies with the key", func(t *testing.T) {
		if err := exec(ctx, t, dsn, "DELETE FROM api_keys WHERE id = 'key_a'"); err != nil {
			t.Fatalf("delete api key: %v", err)
		}
		if queryBool(ctx, t, dsn, "SELECT EXISTS (SELECT 1 FROM api_key_health WHERE key_id = 'key_a')") {
			t.Error("the deleted key kept its health row, and the tab would list a key that no longer exists")
		}
	})

	t.Run("one rate pair per match per workspace", func(t *testing.T) {
		insert := `INSERT INTO pricing_overrides (id, workspace_id, match, input_per_mtok, output_per_mtok) VALUES ($1, $2, $3, $4, $5)`
		if err := exec(ctx, t, dsn, insert, "po_1", "ws_a", "gpt-4", 1.5, 3.0); err != nil {
			t.Fatalf("insert override: %v", err)
		}
		if err := exec(ctx, t, dsn, insert, "po_2", "ws_a", "gpt-4", 2.5, 5.0); err == nil {
			t.Error("a second override took the same match; the resolver would have to break a tie between two rates")
		}
		// A longer prefix is a different override, not a duplicate — the
		// precedence D167 rules is between distinct rows.
		if err := exec(ctx, t, dsn, insert, "po_3", "ws_a", "gpt-4o-mini", 0.15, 0.6); err != nil {
			t.Errorf("a more specific match was refused: %v", err)
		}
		if err := exec(ctx, t, dsn, insert, "po_4", "ws_missing", "gpt-4", 1.0, 1.0); err == nil {
			t.Error("an override was saved against a workspace that does not exist")
		}
		if err := exec(ctx, t, dsn, "DELETE FROM workspaces WHERE id = 'ws_a'"); err != nil {
			t.Fatalf("delete workspace: %v", err)
		}
		if queryBool(ctx, t, dsn, "SELECT EXISTS (SELECT 1 FROM pricing_overrides WHERE workspace_id = 'ws_a')") {
			t.Error("the deleted workspace's overrides survived it")
		}
	})
}
