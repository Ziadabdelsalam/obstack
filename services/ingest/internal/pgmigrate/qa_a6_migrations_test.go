package pgmigrate

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/pgmigrations"
)

// QA A6 — regression + suite-adequacy probes on the Postgres migration set
// (0001-0006) after S3.3 added 0005_metering.sql on top of the S3.1/S3.2 files.
//
// These are the properties the package doc CLAIMS and the standing suite does
// not exercise:
//
//   - "exactly one process applies migrations per upgrade ... the version
//     primary key makes a racing second runner fail loudly at the point it tries
//     to record work someone else did — with its own transaction rolled back and
//     the schema intact" (pgmigrate.go, Run). Nothing in the suite ever starts
//     two runners.
//   - migration idempotence across 0001-0005 as an END STATE, not just as a
//     "second Run applied nothing" count: 0004 and 0005 carry unguarded seed
//     INSERTs (the ws_demo continuity row, the dev key row, the plan catalog),
//     so "no-op" has to be checked on the ROWS, not on the returned version
//     list.
//   - 0001-0004 undrifted by the S3.3 diff: the embedded set is exactly the five
//     versions, in order, and the four inherited files still carry the objects
//     the S3.1/S3.2 exit clauses were signed on.

// a6Runners is how many racing migrators the concurrency probe starts. Two is
// the deployment mistake that actually happens (a second replica with
// OBSTACK_PG_MIGRATE_ON_BOOT left at its default); four makes the interleaving
// hard to get lucky with.
const a6Runners = 4

// TestQAA6ConcurrentRunnersLeaveOneConsistentSchema drives the documented
// racing-runner guarantee. Every runner is allowed to fail — that is the loud
// half of the claim — but the schema they land on must be the same schema one
// runner would have produced: five versions recorded ONCE each, the plan catalog
// at exactly its two seeded rows, and the ws_demo continuity row not duplicated.
func TestQAA6ConcurrentRunnersLeaveOneConsistentSchema(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := freshSchema(ctx, t)

	errs := make([]error, a6Runners)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range a6Runners {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := Run(ctx, dsn, pgmigrations.FS)
			errs[i] = err
		}()
	}
	close(start)
	wg.Wait()

	succeeded := 0
	for i, err := range errs {
		if err == nil {
			succeeded++
			continue
		}
		t.Logf("runner %d failed (allowed, must be loud): %v", i, err)
	}
	if succeeded == 0 {
		t.Fatalf("every racing runner failed; the schema was left to nobody: %v", errs)
	}

	// The schema one runner would have produced.
	for _, version := range []string{"0001_workspaces", "0002_saved_views", "0003_auth", "0004_api_keys", "0005_metering"} {
		if n := queryInt64(ctx, t, dsn, "SELECT count(*) FROM schema_migrations WHERE version = $1", version); n != 1 {
			t.Errorf("schema_migrations records %s %d times, want exactly 1", version, n)
		}
	}
	if n := queryInt64(ctx, t, dsn, "SELECT count(*) FROM plans"); n != 2 {
		t.Errorf("plans holds %d rows after %d racing runners, want the 2 seeded by 0005", n, a6Runners)
	}
	if n := queryInt64(ctx, t, dsn, "SELECT count(*) FROM workspaces WHERE id = 'ws_demo'"); n != 1 {
		t.Errorf("ws_demo continuity row present %d times, want exactly 1", n)
	}
	if n := queryInt64(ctx, t, dsn, "SELECT count(*) FROM api_keys WHERE id = 'key_dev_local'"); n != 1 {
		t.Errorf("key_dev_local continuity row present %d times, want exactly 1", n)
	}
}

// TestQAA6RerunningTheSetChangesNoSeededRow is the idempotence clause read on
// the rows rather than on the version list: after N boots of the same binary
// against the same database, the seeded catalog and the two continuity rows are
// byte-for-byte what one boot produced. A second Run that quietly re-executed a
// file body would show up here and nowhere else in the suite.
func TestQAA6RerunningTheSetChangesNoSeededRow(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := freshSchema(ctx, t)

	first, err := Run(ctx, dsn, pgmigrations.FS)
	if err != nil {
		t.Fatalf("first boot: %v", err)
	}
	embedded, err := pgmigrations.FS.ReadDir(".")
	if err != nil {
		t.Fatalf("read embedded set: %v", err)
	}
	if len(first) != len(embedded) {
		t.Fatalf("first boot applied %v, want all %d embedded versions", first, len(embedded))
	}

	const catalog = `SELECT string_agg(id || '=' || event_quota || '/' || retention_days || '/' || price_usd_month, ',' ORDER BY id) FROM plans`
	want := queryText(ctx, t, dsn, catalog)
	wantHash := queryText(ctx, t, dsn, "SELECT token_hash FROM api_keys WHERE id = 'key_dev_local'")

	for boot := 2; boot <= 4; boot++ {
		ran, err := Run(ctx, dsn, pgmigrations.FS)
		if err != nil {
			t.Fatalf("boot %d: %v", boot, err)
		}
		if len(ran) != 0 {
			t.Fatalf("boot %d applied %v, want nothing", boot, ran)
		}
	}

	if got := queryText(ctx, t, dsn, catalog); got != want {
		t.Errorf("plan catalog drifted across re-runs:\n got %q\nwant %q", got, want)
	}
	if got := queryText(ctx, t, dsn, "SELECT token_hash FROM api_keys WHERE id = 'key_dev_local'"); got != wantHash {
		t.Errorf("dev continuity key hash drifted across re-runs: got %q want %q", got, wantHash)
	}
	// D139's pinned vector, asserted on the row an operator's database actually
	// holds: SHA-256("ok_dev_local"), lowercase hex. This is the value the web
	// app computes at issue time and the value keystore looks up by, so a drift
	// here is the S3.2 clause-4 wire break in its earliest observable form.
	const okDevLocalSHA256 = "45880674fdc48bbcd49721bf6ac190e804836ca4fcd54c736c604153f4947e20"
	if wantHash != okDevLocalSHA256 {
		t.Errorf("continuity row token_hash = %q, want SHA-256(\"ok_dev_local\") = %q", wantHash, okDevLocalSHA256)
	}
}

// TestQAA6InheritedFilesAreUndriftedByS33 pins the set S3.3 inherited: five
// versions in order, and the S3.1/S3.2 objects the earlier exit clauses were
// signed on still built by a fresh boot. The existing
// TestEmbeddedSetIsWhateverIsOnDisk asserts the embed matches the directory —
// which stays green if a file's CONTENT is gutted.
func TestQAA6InheritedFilesAreUndriftedByS33(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := freshSchema(ctx, t)

	if _, err := Run(ctx, dsn, pgmigrations.FS); err != nil {
		t.Fatalf("fresh boot: %v", err)
	}

	// The S3.1 and S3.2 tables, by clause: workspaces (signup lands its own),
	// saved_views (Postgres-backed, per workspace), the better-auth set (session
	// resolution reads `member`), api_keys (issue/revoke).
	for _, table := range []string{"workspaces", "saved_views", "user", "session", "member", "organization", "invitation", "api_keys"} {
		if !tableExists(ctx, t, dsn, table) {
			t.Errorf("inherited table %q is gone after the S3.3 diff", table)
		}
	}

	// S3.1 clause 5: a saved view is scoped by workspace, and the identity is
	// (workspace_id, surface, name) — not name alone.
	if !hasUniqueOver(ctx, t, dsn, "saved_views", []string{"workspace_id", "surface", "name"}) {
		t.Error("saved_views lost its per-workspace identity constraint (S3.1 clause 5)")
	}
	// S3.2 clause 1: the lookup index keystore reads is the UNIQUE on token_hash.
	if !hasUniqueOver(ctx, t, dsn, "api_keys", []string{"token_hash"}) {
		t.Error("api_keys.token_hash lost its UNIQUE — the keystore lookup index (S3.2 clause 1)")
	}

	// The versions, in the order Run applies them.
	got := queryText(ctx, t, dsn, "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")
	const want = "0001_workspaces,0002_saved_views,0003_auth,0004_api_keys,0005_metering,0006_explain_quota,0007_health_windows,0008_metrics_health,0009_dashboards,0010_alerts,0011_change_events,0012_slos"
	if got != want {
		t.Errorf("applied set = %q, want %q", got, want)
	}
}

// TestQAA6PendingIsReadOnlyAgainstAMigratedDatabase re-checks the verify-only
// posture S3.2's chart story rests on, now that a fifth file exists: a replica
// that only verifies must report nothing pending and must not write.
func TestQAA6PendingIsReadOnlyAgainstAMigratedDatabase(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := freshSchema(ctx, t)

	if _, err := Run(ctx, dsn, pgmigrations.FS); err != nil {
		t.Fatalf("fresh boot: %v", err)
	}
	before := queryText(ctx, t, dsn, "SELECT string_agg(version || '@' || applied_at::text, ',' ORDER BY version) FROM schema_migrations")

	todo, err := Pending(ctx, dsn, pgmigrations.FS)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(todo) != 0 {
		t.Errorf("Pending reports %v against a fully migrated database, want nothing", todo)
	}
	if after := queryText(ctx, t, dsn, "SELECT string_agg(version || '@' || applied_at::text, ',' ORDER BY version) FROM schema_migrations"); after != before {
		t.Errorf("Pending wrote to schema_migrations: %q -> %q", before, after)
	}
}

// queryText is queryInt64's string sibling; NULL comes back as the empty string
// so an assertion can say so instead of panicking on a nil scan.
func queryText(ctx context.Context, t *testing.T, dsn, sql string, args ...any) string {
	t.Helper()

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)

	var value *string
	if err := conn.QueryRow(ctx, sql, args...).Scan(&value); err != nil {
		t.Fatalf("query %q: %v", sql, err)
	}
	if value == nil {
		return ""
	}
	return *value
}

// hasUniqueOver reports whether the table carries a UNIQUE or PRIMARY KEY over
// exactly the named columns, read from the catalog rather than from the file, so
// a migration edited to drop a constraint is what goes red.
func hasUniqueOver(ctx context.Context, t *testing.T, dsn, table string, columns []string) bool {
	t.Helper()

	const sql = `
	  SELECT coalesce(string_agg(cols, ';'), '') FROM (
	    SELECT (SELECT string_agg(a.attname, ',' ORDER BY a.attname)
	              FROM unnest(c.conkey) k
	              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS cols
	      FROM pg_constraint c
	     WHERE c.conrelid = $1::regclass AND c.contype IN ('u', 'p')
	  ) s`
	want := strings.Join(sortedCopy(columns), ",")
	for _, cols := range strings.Split(queryText(ctx, t, dsn, sql, table), ";") {
		if cols == want {
			return true
		}
	}
	return false
}

func sortedCopy(in []string) []string {
	out := append([]string(nil), in...)
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if out[j] < out[i] {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}
