package migrate

import (
	"context"
	"os"
	"reflect"
	"testing"
	"testing/fstest"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/migrations"
)

// These tests run against a real ClickHouse — the compose stack from
// deploy/compose by default, overridable for CI, the same way the writer's do.
// Pending is a claim about what the server has recorded, and a fake server would
// only be a claim about the fake.
const defaultDSN = "clickhouse://obstack_ingest:obstack_ingest_dev@127.0.0.1:9000/obstack"

func testDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_CLICKHOUSE_DSN"); dsn != "" {
		return dsn
	}
	return defaultDSN
}

// requireClickHouse skips rather than fails when no server is reachable: a
// laptop without the compose stack up should not report a broken migrator. It
// pings `default`, not the DSN's database, for the same reason Run connects
// there — on a fresh volume obstack does not exist yet, and a probe that asked
// for it would skip precisely the case the migrator exists to handle.
func requireClickHouse(t *testing.T) context.Context {
	t.Helper()

	opts, err := clickhouse.ParseDSN(testDSN())
	if err != nil {
		t.Fatalf("parse test DSN: %v", err)
	}
	opts.Auth.Database = "default"
	conn, err := clickhouse.Open(opts)
	if err != nil {
		t.Fatalf("open clickhouse: %v", err)
	}
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pingCtx, cancelPing := context.WithTimeout(ctx, 5*time.Second)
	defer cancelPing()
	if err := conn.Ping(pingCtx); err != nil {
		t.Skipf("no ClickHouse at %s (%v); start deploy/compose to run the migrate integration tests", testDSN(), err)
	}
	return ctx
}

// The compose database is shared with the writer's tests and nothing can hand
// this one a virgin schema_migrations, so the assertions are about the shape of
// the answer, not about a fixed applied set: after Run there is nothing left
// pending, and a version the server has never seen is reported as pending
// whatever else is already there.
func TestPendingIsEmptyOnceApplied(t *testing.T) {
	ctx := requireClickHouse(t)

	if _, err := Run(ctx, testDSN(), migrations.FS); err != nil {
		t.Fatalf("Run: %v", err)
	}

	todo, err := Pending(ctx, testDSN(), migrations.FS)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(todo) != 0 {
		t.Errorf("Pending after Run = %v, want none", todo)
	}

	// The claim the package doc makes about a second boot, asserted rather than
	// described.
	ran, err := Run(ctx, testDSN(), migrations.FS)
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}
	if len(ran) != 0 {
		t.Errorf("second Run applied %v, want nothing", ran)
	}
}

// A version the binary carries and the server has not recorded is exactly the
// case a verifying pod exists to catch, so Pending is asked about one directly.
// It reads without applying, so an invented version is safe to ask about.
func TestPendingReportsUnappliedVersions(t *testing.T) {
	ctx := requireClickHouse(t)

	fsys := fstest.MapFS{
		"0001_spans.sql":            {Data: []byte("SELECT 1")},
		"9998_not_applied.sql":      {Data: []byte("SELECT 1")},
		"9999_also_not_applied.sql": {Data: []byte("SELECT 1")},
	}
	if _, err := Run(ctx, testDSN(), migrations.FS); err != nil {
		t.Fatalf("Run: %v", err)
	}

	todo, err := Pending(ctx, testDSN(), fsys)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	// 0001_spans is applied by the Run above; the two invented ones are not, and
	// they come back in the order Run would apply them.
	want := []string{"9998_not_applied", "9999_also_not_applied"}
	if !reflect.DeepEqual(todo, want) {
		t.Errorf("Pending = %v, want %v", todo, want)
	}

	if todo, err := Pending(ctx, testDSN(), fstest.MapFS{}); err != nil || len(todo) != 0 {
		t.Errorf("Pending over an empty FS = %v, %v; want none, nil", todo, err)
	}
}
