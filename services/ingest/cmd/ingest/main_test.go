package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/jackc/pgx/v5"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/config"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/migrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pgmigrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/migrations"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/pgmigrations"
)

// The compose stack from deploy/compose by default, overridable for CI, matching
// the writer's and the migrator's integration tests. The Postgres one is the
// same set of fixing values internal/pgmigrate documents its `docker run
// postgres:17.11` with.
const (
	defaultDSN         = "clickhouse://obstack_ingest:obstack_ingest_dev@127.0.0.1:9000/obstack"
	defaultPostgresDSN = "postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack"
)

func testDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_CLICKHOUSE_DSN"); dsn != "" {
		return dsn
	}
	return defaultDSN
}

func testPostgresDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_POSTGRES_DSN"); dsn != "" {
		return dsn
	}
	return defaultPostgresDSN
}

// requirePostgres skips rather than fails when no server is reachable, for the
// same reason requireClickHouse does.
func requirePostgres(t *testing.T) context.Context {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)

	pingCtx, cancelPing := context.WithTimeout(ctx, 5*time.Second)
	defer cancelPing()
	conn, err := pgx.Connect(pingCtx, testPostgresDSN())
	if err != nil {
		t.Skipf("no Postgres at %s (%v); start deploy/compose or the documented postgres:17.11 container to run the pg-migrate subcommand tests", testPostgresDSN(), err)
	}
	conn.Close(ctx)
	return ctx
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

// The point of the subcommand's narrow loader: a migration Job carries the DSN
// of the store it migrates and nothing else. Asserted without a server because
// the failure being ruled out is a config one — the DSN below never parses, so
// the only way to reach that error is to have got past config with nothing else
// set.
func TestRunMigrateNeedsOnlyDSN(t *testing.T) {
	t.Setenv("OBSTACK_POSTGRES_DSN", "")
	t.Setenv("CLICKHOUSE_DSN", "not-a-dsn")

	err := runMigrate()
	if err == nil {
		t.Fatal("runMigrate succeeded against an unparseable DSN, want error")
	}
	if strings.Contains(err.Error(), "OBSTACK_POSTGRES_DSN") {
		t.Errorf("runMigrate demanded the other store's DSN: %v", err)
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
// with nothing in its environment but the DSN of the store it owns.
func TestRunMigrateAppliesSchema(t *testing.T) {
	requireClickHouse(t)

	t.Setenv("OBSTACK_POSTGRES_DSN", "")
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

// The Postgres one-shot carries the same narrowness: its Job needs the Postgres
// DSN and nothing else — not the ClickHouse DSN whose schema a different Job
// owns.
func TestRunPGMigrateNeedsOnlyItsOwnDSN(t *testing.T) {
	t.Setenv("CLICKHOUSE_DSN", "")
	t.Setenv("OBSTACK_POSTGRES_DSN", "not-a-dsn")

	err := runPGMigrate()
	if err == nil {
		t.Fatal("runPGMigrate succeeded against an unparseable DSN, want error")
	}
	if strings.Contains(err.Error(), "CLICKHOUSE_DSN") {
		t.Errorf("runPGMigrate demanded CLICKHOUSE_DSN: %v", err)
	}
	if !strings.Contains(err.Error(), "OBSTACK_POSTGRES_DSN") {
		t.Errorf("runPGMigrate error = %v, want it to name OBSTACK_POSTGRES_DSN", err)
	}

	t.Setenv("OBSTACK_POSTGRES_DSN", "")
	if err := runPGMigrate(); err == nil {
		t.Error("runPGMigrate succeeded with no OBSTACK_POSTGRES_DSN, want error")
	}
}

// The one-shot end to end against a real server, twice, because a pre-upgrade
// hook reruns on every deploy.
func TestRunPGMigrateAppliesSchema(t *testing.T) {
	requirePostgres(t)

	t.Setenv("CLICKHOUSE_DSN", "")
	t.Setenv("OBSTACK_POSTGRES_DSN", testPostgresDSN())

	if err := runPGMigrate(); err != nil {
		t.Fatalf("runPGMigrate: %v", err)
	}
	if err := runPGMigrate(); err != nil {
		t.Fatalf("second runPGMigrate: %v", err)
	}
}

// The boot posture the deleted env map leaves behind (D95(e)): there is no
// Postgres-less serve any more, because that is where the keys are. A serving
// process without OBSTACK_POSTGRES_DSN has to stop and name it, before it binds
// a port or accepts one export it would have to 401. Hermetic — the refusal
// happens in config, and a laptop with nothing running must still prove it.
func TestRunRefusesToServeWithoutPostgres(t *testing.T) {
	t.Setenv("CLICKHOUSE_DSN", "clickhouse://obstack_ingest:pw@127.0.0.1:9000/obstack")
	t.Setenv("OBSTACK_MIGRATE_ON_BOOT", "")
	t.Setenv("OBSTACK_POSTGRES_DSN", "")

	err := run()
	if err == nil {
		t.Fatal("run served with no Postgres to resolve API keys against, want refusal")
	}
	if !strings.Contains(err.Error(), "OBSTACK_POSTGRES_DSN") {
		t.Errorf("error = %v, want it to name the variable an operator has to set", err)
	}
}

// The boot flag is a tri-state in practice — unset, set, or set to nonsense —
// and only the last one is interesting: a value nobody can parse must stop boot
// rather than pick an owner for the schema by accident.
func TestPGMigrateOnBoot(t *testing.T) {
	for _, tc := range []struct {
		value   string
		want    bool
		wantErr bool
	}{
		{value: "", want: true},
		{value: "false", want: false},
		{value: " false ", want: false},
		{value: "true", want: true},
		{value: "ture", wantErr: true},
	} {
		t.Run(fmt.Sprintf("%q", tc.value), func(t *testing.T) {
			t.Setenv("OBSTACK_PG_MIGRATE_ON_BOOT", tc.value)
			got, err := pgMigrateOnBoot()
			if tc.wantErr {
				if err == nil {
					t.Fatalf("pgMigrateOnBoot(%q) = %v, nil; want an error", tc.value, got)
				}
				if !strings.Contains(err.Error(), "OBSTACK_PG_MIGRATE_ON_BOOT") {
					t.Errorf("error = %v, want it to name the variable", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("pgMigrateOnBoot(%q): %v", tc.value, err)
			}
			if got != tc.want {
				t.Errorf("pgMigrateOnBoot(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
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

// The same switch over the other store, against a real server: a current schema
// boots either way, and a version behind the binary stops boot without being
// applied by the process that is only supposed to be verifying.
func TestEnsurePGSchemaSwitchesOnTheBootFlag(t *testing.T) {
	ctx := requirePostgres(t)
	dsn := testPostgresDSN()

	if err := ensurePGSchema(ctx, dsn, true, pgmigrations.FS, pgmigrate.Pending); err != nil {
		t.Fatalf("ensurePGSchema applying: %v", err)
	}
	if err := ensurePGSchema(ctx, dsn, false, pgmigrations.FS, pgmigrate.Pending); err != nil {
		t.Fatalf("ensurePGSchema verifying a current schema: %v", err)
	}

	fsys := fstest.MapFS{"9999_never_applied.sql": {Data: []byte("SELECT 1")}}
	err := ensurePGSchema(ctx, dsn, false, fsys, pgmigrate.Pending)
	if err == nil {
		t.Fatal("ensurePGSchema accepted a schema behind the binary, want error")
	}
	if !strings.Contains(err.Error(), "9999_never_applied") {
		t.Errorf("error = %v, want it to name the unapplied version", err)
	}

	todo, err := pgmigrate.Pending(ctx, dsn, fsys)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(todo) != 1 {
		t.Errorf("Pending = %v, want the version still unapplied — verify must not apply", todo)
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

// The Postgres half of the same safety property, held to the same standard: it
// has to hold on a laptop with no Postgres anywhere.
func TestEnsurePGSchemaRefusalIsHermetic(t *testing.T) {
	const dsn = "postgres://unused"

	t.Run("pending versions stop boot and are named", func(t *testing.T) {
		pending := func(context.Context, string, fs.FS) ([]string, error) {
			return []string{"0001_workspaces", "0002_saved_views"}, nil
		}
		err := ensurePGSchema(t.Context(), dsn, false, pgmigrations.FS, pending)
		if err == nil {
			t.Fatal("ensurePGSchema returned nil with migrations pending, want refusal")
		}
		for _, want := range []string{"0001_workspaces", "0002_saved_views", "OBSTACK_PG_MIGRATE_ON_BOOT", "ingest pg-migrate"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("error = %q, want it to mention %q", err, want)
			}
		}
	})

	t.Run("a current schema boots", func(t *testing.T) {
		pending := func(context.Context, string, fs.FS) ([]string, error) { return nil, nil }
		if err := ensurePGSchema(t.Context(), dsn, false, pgmigrations.FS, pending); err != nil {
			t.Fatalf("ensurePGSchema with nothing pending: %v", err)
		}
	})

	t.Run("a failed check stops boot", func(t *testing.T) {
		pending := func(context.Context, string, fs.FS) ([]string, error) {
			return nil, errors.New("dial tcp: connection refused")
		}
		err := ensurePGSchema(t.Context(), dsn, false, pgmigrations.FS, pending)
		if err == nil {
			t.Fatal("ensurePGSchema returned nil when the schema check failed, want refusal")
		}
		if !strings.Contains(err.Error(), "connection refused") {
			t.Errorf("error = %q, want it to carry the underlying cause", err)
		}
	})
}
