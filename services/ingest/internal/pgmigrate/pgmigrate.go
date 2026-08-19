// Package pgmigrate applies the obstack Postgres schema — the second tracked
// migration set ingest owns (D95), alongside internal/migrate's ClickHouse one.
// The two are the same class deliberately: embedded SQL run in filename order,
// each applied file recorded in a schema_migrations table so a second boot is a
// no-op and an upgrade takes exactly the path a first boot does, and no
// docker-entrypoint-initdb.d, because DDL that only ever runs against an empty
// volume is DDL that has never been tested on the case that matters.
//
// Which process applies them is deployment-shaped — the serving one at boot, or
// the `ingest pg-migrate` one-shot with the servers reduced to Pending — but it
// is always this code, and always exactly one runner per upgrade. Run explains
// why that is a deployment guarantee rather than a lock.
//
// The tracking table shares its name with the ClickHouse set's and cannot
// collide with it: different server, different store. The runner's log lines in
// cmd/ingest name which store they are talking about (D112) so a boot log reads
// unambiguously.
package pgmigrate

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// The migration SQL and the registry below name their objects unqualified: the
// database comes from the DSN and the schema from the connection's search_path,
// which is what lets a test hand this package a throwaway schema and get a
// genuine fresh boot. There is no CREATE DATABASE equivalent to the ClickHouse
// set's — a role cannot create the database it is already connected to, and
// provisioning it is the deployment's job (compose env, the chart's Postgres,
// or a managed instance).
const createSchemaMigrations = `
CREATE TABLE IF NOT EXISTS schema_migrations
(
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`

// Run brings the schema up to date and reports the versions it applied — empty
// when there was nothing to do. A file that fails takes nothing with it: see
// apply.
//
// There is no lock around the read-then-apply below. Postgres does have advisory
// locks, unlike ClickHouse, and taking one here would still be the wrong shape:
// the guarantee this deployment model rests on is structural — exactly one
// process applies migrations per upgrade. Compose has one ingest container;
// Kubernetes runs `ingest pg-migrate` as a pre-upgrade Job and sets
// OBSTACK_PG_MIGRATE_ON_BOOT=false on the Deployment, so its replicas only
// verify (see Pending). A lock would let a second runner exist and hide it,
// where the version primary key makes a racing second runner fail loudly at the
// point it tries to record work someone else did — with its own transaction
// rolled back and the schema intact.
func Run(ctx context.Context, dsn string, fsys fs.FS) ([]string, error) {
	conn, err := connect(ctx, dsn)
	if err != nil {
		return nil, err
	}
	defer conn.Close(ctx)

	if err := ensureRegistry(ctx, conn); err != nil {
		return nil, err
	}
	todo, err := pending(ctx, conn, fsys)
	if err != nil {
		return nil, err
	}

	var ran []string
	for _, version := range todo {
		name := version + ".sql"
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return nil, fmt.Errorf("read migration %s: %w", name, err)
		}
		if err := apply(ctx, conn, version, string(body)); err != nil {
			return nil, err
		}
		ran = append(ran, version)
	}
	return ran, nil
}

// Pending reports the versions this binary carries that the database has not
// recorded, in the order Run would apply them — empty when the schema is
// current. It is what a process that does not own the schema checks before it
// serves: OBSTACK_PG_MIGRATE_ON_BOOT=false means "someone else applies", not
// "skip the schema", so a chart whose migration Job never ran crash-loops
// instead of serving against tables that are not there.
//
// It is strictly read-only, and that is the point rather than an accident: a
// verify-only replica must be deployable with a Postgres role holding no DDL
// grant at all, so "who applies" can be narrowed to the migration Job by
// privilege and not merely by convention. An absent registry is therefore read
// as "nothing applied" rather than created — see appliedVersions.
//
// It detects only forward skew: versions this binary carries that the database
// lacks. A pod running an image older than the schema verifies clean, which is
// survivable for exactly as long as every migration is additive.
func Pending(ctx context.Context, dsn string, fsys fs.FS) ([]string, error) {
	conn, err := connect(ctx, dsn)
	if err != nil {
		return nil, err
	}
	defer conn.Close(ctx)

	return pending(ctx, conn, fsys)
}

// connect parses before it dials so a malformed DSN is reported as the
// configuration mistake it is, naming the variable an operator has to go fix,
// rather than as a connection failure to an address nobody wrote down.
func connect(ctx context.Context, dsn string) (*pgx.Conn, error) {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse OBSTACK_POSTGRES_DSN: %w", err)
	}
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	return conn, nil
}

// apply runs one migration file and records it in the same transaction. Postgres
// has transactional DDL, so a file that fails halfway leaves nothing behind and
// nothing recorded: the next run retries it from the top instead of resuming
// into a half-created schema, and the error names the file that stopped it.
//
// The whole file goes over in one Exec, which pgx sends over the simple query
// protocol whenever there are no arguments — several statements per round trip.
// That is why this package has no statement splitter; internal/migrate needs one
// only because ClickHouse's native protocol takes exactly one statement at a
// time, and a splitter is a SQL parser that will eventually meet SQL it does not
// parse.
//
// A multi-statement simple query is already atomic on its own — Postgres wraps
// one in an implicit transaction — so the explicit transaction here is for the
// join between the two Execs: the version record commits with the DDL it
// describes, or neither does. Without it a connection lost in that gap would
// leave a migration applied and unrecorded, and the next run would apply it a
// second time.
func apply(ctx context.Context, conn *pgx.Conn, version, body string) error {
	name := version + ".sql"

	tx, err := conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin migration %s: %w", name, err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, body); err != nil {
		return fmt.Errorf("migration %s: %w", name, err)
	}
	if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES ($1)", version); err != nil {
		return fmt.Errorf("record migration %s: %w", name, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit migration %s: %w", name, err)
	}
	return nil
}

// ensureRegistry makes the version table exist so a first run reads an empty
// applied set rather than an error. Only Run calls it — the verify path stays
// read-only and infers the same empty set from the registry's absence.
func ensureRegistry(ctx context.Context, conn *pgx.Conn) error {
	if _, err := conn.Exec(ctx, createSchemaMigrations); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	return nil
}

// pending is the version comparison Run and Pending share: the embedded files in
// filename order, minus what schema_migrations already records. Applying and
// verifying must never disagree about what "up to date" means, so they read it
// from one place.
func pending(ctx context.Context, conn *pgx.Conn, fsys fs.FS) ([]string, error) {
	applied, err := appliedVersions(ctx, conn)
	if err != nil {
		return nil, err
	}

	names, err := fs.Glob(fsys, "*.sql")
	if err != nil {
		return nil, fmt.Errorf("list migrations: %w", err)
	}
	sort.Strings(names)

	var todo []string
	for _, name := range names {
		version := strings.TrimSuffix(name, ".sql")
		if _, done := applied[version]; done {
			continue
		}
		todo = append(todo, version)
	}
	return todo, nil
}

func appliedVersions(ctx context.Context, conn *pgx.Conn) (map[string]struct{}, error) {
	rows, err := conn.Query(ctx, "SELECT version FROM schema_migrations")
	if err != nil {
		// A registry that is not there yet has recorded nothing, which is the
		// truthful answer on a fresh database and the one that keeps Pending
		// read-only. Reporting every version as pending is also the diagnosis an
		// operator needs, where a raw undefined_table reads like an outage
		// rather than a migration Job that never ran.
		if isMissingRegistry(err) {
			return map[string]struct{}{}, nil
		}
		return nil, fmt.Errorf("read applied migrations: %w", err)
	}
	defer rows.Close()

	applied := map[string]struct{}{}
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			return nil, fmt.Errorf("scan applied migration: %w", err)
		}
		applied[version] = struct{}{}
	}
	return applied, rows.Err()
}

// codeUndefinedTable is the SQLSTATE for "the relation you named is not there".
// Branching on the code rather than the message because the message is
// localisable and the code is not.
const codeUndefinedTable = "42P01"

// isMissingRegistry distinguishes an unmigrated database from a broken one. It
// is deliberately narrow: any other failure — auth, network, a permission the
// deployment forgot — must still surface, because reading those as "nothing
// applied" would turn an outage into a silent full re-migration.
func isMissingRegistry(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	return pgErr.Code == codeUndefinedTable
}
