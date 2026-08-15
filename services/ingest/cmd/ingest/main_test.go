package main

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/config"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/migrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/migrations"
)

// The compose stack from deploy/compose by default, overridable for CI, matching
// the writer's and the migrator's integration tests.
const defaultDSN = "clickhouse://obstack_ingest:obstack_ingest_dev@127.0.0.1:9000/obstack"

func testDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_CLICKHOUSE_DSN"); dsn != "" {
		return dsn
	}
	return defaultDSN
}

// requireClickHouse skips rather than fails when no server is reachable: a
// laptop without the compose stack up should not report a broken binary. It
// pings `default` rather than the DSN's database, so a fresh volume — the case
// the migrate subcommand exists for — runs the tests instead of skipping them.
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
		t.Skipf("no ClickHouse at %s (%v); start deploy/compose to run the migrate subcommand tests", testDSN(), err)
	}
	return ctx
}

// The point of the subcommand's narrow loader: a migration Job must not have to
// carry the ingest bearer keys. Asserted without a server because the failure
// being ruled out is a config one — the DSN below never parses, so the only way
// to reach that error is to have got past config without OBSTACK_API_KEYS set.
func TestRunMigrateNeedsOnlyDSN(t *testing.T) {
	t.Setenv("OBSTACK_API_KEYS", "")
	t.Setenv("CLICKHOUSE_DSN", "not-a-dsn")

	err := runMigrate()
	if err == nil {
		t.Fatal("runMigrate succeeded against an unparseable DSN, want error")
	}
	if strings.Contains(err.Error(), "OBSTACK_API_KEYS") {
		t.Errorf("runMigrate demanded API keys: %v", err)
	}
	if !strings.Contains(err.Error(), "CLICKHOUSE_DSN") {
		t.Errorf("runMigrate error = %v, want it to name CLICKHOUSE_DSN", err)
	}

	t.Setenv("CLICKHOUSE_DSN", "")
	if err := runMigrate(); err == nil {
		t.Error("runMigrate succeeded with no CLICKHOUSE_DSN, want error")
	}
}

// The one-shot end to end: it applies, it exits without error, and it does so
// with no API keys in its environment.
func TestRunMigrateAppliesSchema(t *testing.T) {
	requireClickHouse(t)

	t.Setenv("OBSTACK_API_KEYS", "")
	t.Setenv("CLICKHOUSE_DSN", testDSN())

	if err := runMigrate(); err != nil {
		t.Fatalf("runMigrate: %v", err)
	}
	// Idempotent, which is what makes it safe as a pre-upgrade hook that reruns
	// on every deploy.
	if err := runMigrate(); err != nil {
		t.Fatalf("second runMigrate: %v", err)
	}
}

// OBSTACK_MIGRATE_ON_BOOT=false must not degrade into "serve anyway". A version
// the server has never recorded has to stop boot before anything binds.
func TestEnsureSchemaRefusesWhenPending(t *testing.T) {
	ctx := requireClickHouse(t)

	if _, err := migrate.Run(ctx, testDSN(), migrations.FS); err != nil {
		t.Fatalf("apply schema: %v", err)
	}
	cfg := config.Config{ClickHouseDSN: testDSN(), MigrateOnBoot: false}

	// Never applied, and ensureSchema is not allowed to apply it.
	fsys := fstest.MapFS{"9999_never_applied.sql": {Data: []byte("SELECT 1")}}
	err := ensureSchema(ctx, cfg, fsys, migrate.Pending)
	if err == nil {
		t.Fatal("ensureSchema accepted a schema behind the binary, want error")
	}
	if !strings.Contains(err.Error(), "9999_never_applied") {
		t.Errorf("error = %v, want it to name the unapplied version", err)
	}
	if !strings.Contains(err.Error(), "OBSTACK_MIGRATE_ON_BOOT") {
		t.Errorf("error = %v, want it to name the variable that put this process in verify-only mode", err)
	}

	todo, err := migrate.Pending(ctx, testDSN(), fsys)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(todo) != 1 {
		t.Errorf("Pending = %v, want the version still unapplied — verify must not apply", todo)
	}
}

// The other half of the same switch: a current schema boots, and a process that
// does own its schema applies what is missing.
func TestEnsureSchemaAcceptsCurrentSchema(t *testing.T) {
	ctx := requireClickHouse(t)

	cfg := config.Config{ClickHouseDSN: testDSN(), MigrateOnBoot: true}
	if err := ensureSchema(ctx, cfg, migrations.FS, migrate.Pending); err != nil {
		t.Fatalf("ensureSchema with MigrateOnBoot: %v", err)
	}

	cfg.MigrateOnBoot = false
	if err := ensureSchema(ctx, cfg, migrations.FS, migrate.Pending); err != nil {
		t.Fatalf("ensureSchema verifying a current schema: %v", err)
	}
}

// The refusal is the safety property, so it is also tested without a database:
// every test above skips when no ClickHouse is reachable, and `go test ./...`
// on a laptop with nothing running must still prove that a pending schema stops
// boot. The injected lookup stands in for the round trip.
func TestEnsureSchemaRefusalIsHermetic(t *testing.T) {
	cfg := config.Config{ClickHouseDSN: "clickhouse://unused", MigrateOnBoot: false}

	t.Run("pending versions stop boot and are named", func(t *testing.T) {
		pending := func(context.Context, string, fs.FS) ([]string, error) {
			return []string{"0002_logs", "0003_trace_summaries"}, nil
		}
		err := ensureSchema(t.Context(), cfg, migrations.FS, pending)
		if err == nil {
			t.Fatal("ensureSchema returned nil with migrations pending, want refusal")
		}
		for _, want := range []string{"0002_logs", "0003_trace_summaries", "OBSTACK_MIGRATE_ON_BOOT", "ingest migrate"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("error = %q, want it to mention %q", err, want)
			}
		}
	})

	t.Run("a current schema boots", func(t *testing.T) {
		pending := func(context.Context, string, fs.FS) ([]string, error) { return nil, nil }
		if err := ensureSchema(t.Context(), cfg, migrations.FS, pending); err != nil {
			t.Fatalf("ensureSchema with nothing pending: %v", err)
		}
	})

	// An unreachable database must not read as "nothing pending". Serving on a
	// failed check is the same outage as serving on a missing table, arrived at
	// more quietly.
	t.Run("a failed check stops boot", func(t *testing.T) {
		pending := func(context.Context, string, fs.FS) ([]string, error) {
			return nil, errors.New("dial tcp: connection refused")
		}
		err := ensureSchema(t.Context(), cfg, migrations.FS, pending)
		if err == nil {
			t.Fatal("ensureSchema returned nil when the schema check failed, want refusal")
		}
		if !strings.Contains(err.Error(), "connection refused") {
			t.Errorf("error = %q, want it to carry the underlying cause", err)
		}
	})
}
