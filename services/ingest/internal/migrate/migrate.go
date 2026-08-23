// Package migrate applies the obstack ClickHouse schema at service boot (D14).
// The embedded SQL files run in filename order and each applied file is recorded
// in obstack.schema_migrations, so a second boot is a no-op and an upgrade takes
// exactly the same path a first boot does. There is deliberately no
// docker-entrypoint-initdb.d: DDL that only ever runs against an empty volume is
// DDL that has never been tested on the case that matters.
//
// Which process applies them is deployment-shaped — the serving one at boot, or
// the `ingest migrate` one-shot with the servers reduced to Pending — but it is
// always this code, and always exactly one runner per upgrade. Run explains why
// that is a deployment guarantee rather than a lock.
package migrate

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	chproto "github.com/ClickHouse/clickhouse-go/v2/lib/proto"
)

// Database is the single database every obstack table lives in (D7). The
// migration SQL fully qualifies its object names against it.
const Database = "obstack"

const createSchemaMigrations = `
CREATE TABLE IF NOT EXISTS ` + Database + `.schema_migrations
(
    version    String,
    applied_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY version`

// Run brings the schema up to date and reports the versions it applied — empty
// when there was nothing to do.
//
// There is no lock around the read-then-apply below, and deliberately never will
// be. ClickHouse has no advisory locks; the only primitive that would serialise
// this is a KeeperMap table, and that makes ClickHouse Keeper a hard dependency
// for every single-node self-hoster — a standing operational cost paid against a
// misconfiguration the deployment model already rules out. The guarantee is
// structural instead: exactly one process applies migrations per upgrade.
// Compose has one ingest container; Kubernetes runs `ingest migrate` as a
// pre-upgrade Job and sets OBSTACK_MIGRATE_ON_BOOT=false on the Deployment, so
// its replicas only verify (see Pending). Concurrent runners are survivable
// today because every shipped statement converges on the same end state under
// repetition: the CREATEs are IF NOT EXISTS, and 0004's ALTER ... MODIFY TTL
// sets a fixed literal, so two runners applying it reach one answer and the
// MATERIALIZE TTL it triggers is itself idempotent. That is a property of the
// statements currently shipped, not a guarantee of the mechanism — a
// non-convergent ALTER (one computed from the current schema, say) would end
// it — which is exactly why the fix is one runner rather than a lock nobody
// can afford.
func Run(ctx context.Context, dsn string, fsys fs.FS) ([]string, error) {
	conn, err := connect(dsn)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

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
		for i, stmt := range SplitStatements(string(body)) {
			if err := conn.Exec(ctx, stmt); err != nil {
				return nil, fmt.Errorf("migration %s statement %d: %w", name, i+1, err)
			}
		}
		if err := conn.Exec(ctx,
			"INSERT INTO "+Database+".schema_migrations (version) VALUES (?)", version); err != nil {
			return nil, fmt.Errorf("record migration %s: %w", name, err)
		}
		ran = append(ran, version)
	}
	return ran, nil
}

// Pending reports the versions this binary carries that the database has not
// recorded, in the order Run would apply them — empty when the schema is
// current. It is what a process that does not own the schema checks before it
// serves: OBSTACK_MIGRATE_ON_BOOT=false means "someone else applies", not "skip
// the schema", so a chart whose migration Job never ran crash-loops instead of
// answering queries against a table missing columns.
//
// It is strictly read-only, and that is the point rather than an accident: a
// verify-only replica must be deployable with a ClickHouse user holding no DDL
// grant at all, so "who applies" can be narrowed to the migration Job by
// privilege and not merely by convention. An absent registry is therefore read
// as "nothing applied" rather than created — see appliedVersions.
//
// It detects only forward skew: versions this binary carries that the database
// lacks. A pod running an image older than the schema verifies clean, which is
// survivable for exactly as long as an applied migration leaves the older
// binary's statements valid. 0004 widens a TTL, which no earlier version reads
// or depends on, so the property still holds — but it now holds per-migration
// rather than by the blanket "everything is additive" that CREATE-only sets
// gave for free. The same caveat Run carries.
func Pending(ctx context.Context, dsn string, fsys fs.FS) ([]string, error) {
	conn, err := connect(dsn)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	return pending(ctx, conn, fsys)
}

func connect(dsn string) (driver.Conn, error) {
	opts, err := clickhouse.ParseDSN(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse CLICKHOUSE_DSN: %w", err)
	}
	// On a fresh volume the obstack database does not exist yet, and the
	// handshake sets the session database before a single statement runs. Boot
	// against `default` instead and let the SQL qualify its own names.
	opts.Auth.Database = "default"

	conn, err := clickhouse.Open(opts)
	if err != nil {
		return nil, fmt.Errorf("open clickhouse: %w", err)
	}
	return conn, nil
}

// ensureRegistry makes the version table exist so a first run reads an empty
// applied set rather than an error. Only Run calls it — the verify path stays
// read-only and infers the same empty set from the registry's absence.
func ensureRegistry(ctx context.Context, conn driver.Conn) error {
	if err := conn.Exec(ctx, "CREATE DATABASE IF NOT EXISTS "+Database); err != nil {
		return fmt.Errorf("create database %s: %w", Database, err)
	}
	if err := conn.Exec(ctx, createSchemaMigrations); err != nil {
		return fmt.Errorf("create %s.schema_migrations: %w", Database, err)
	}
	return nil
}

// pending is the version comparison Run and Pending share: the embedded files in
// filename order, minus what schema_migrations already records. Applying and
// verifying must never disagree about what "up to date" means, so they read it
// from one place.
func pending(ctx context.Context, conn driver.Conn, fsys fs.FS) ([]string, error) {
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

func appliedVersions(ctx context.Context, conn driver.Conn) (map[string]struct{}, error) {
	rows, err := conn.Query(ctx, "SELECT version FROM "+Database+".schema_migrations")
	if err != nil {
		// A registry that is not there yet has recorded nothing, which is the
		// truthful answer on a fresh volume and the one that keeps Pending
		// read-only. Reporting every version as pending is also the diagnosis an
		// operator needs, where a raw UNKNOWN_DATABASE reads like an outage
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

// ClickHouse error codes for "the thing you named is not there". Branching on
// the numbers rather than the message text because CodeName is documented as
// best-effort and empty over the native protocol this driver speaks.
const (
	codeUnknownTable    int32 = 60
	codeUnknownDatabase int32 = 81
)

// isMissingRegistry distinguishes an unmigrated database from a broken one. It
// is deliberately narrow: any other failure — auth, network, a permission the
// deployment forgot — must still surface, because reading those as "nothing
// applied" would turn an outage into a silent full re-migration.
func isMissingRegistry(err error) bool {
	var ex *chproto.Exception
	if !errors.As(err, &ex) {
		return false
	}
	return ex.Code == codeUnknownTable || ex.Code == codeUnknownDatabase
}

// SplitStatements cuts a migration file into individual statements. ClickHouse's
// native protocol takes one statement per Exec, and 0003 ships a target table
// plus its materialized view. Line comments are stripped and semicolons inside
// string literals (the Enum8 definitions) are left alone.
func SplitStatements(sql string) []string {
	var (
		stmts   []string
		current strings.Builder
		inQuote bool
	)
	flush := func() {
		if s := strings.TrimSpace(current.String()); s != "" {
			stmts = append(stmts, s)
		}
		current.Reset()
	}
	for i := 0; i < len(sql); i++ {
		c := sql[i]
		switch {
		case inQuote:
			current.WriteByte(c)
			if c == '\\' && i+1 < len(sql) {
				i++
				current.WriteByte(sql[i])
			} else if c == '\'' {
				inQuote = false
			}
		case c == '\'':
			inQuote = true
			current.WriteByte(c)
		case c == '-' && i+1 < len(sql) && sql[i+1] == '-':
			for i < len(sql) && sql[i] != '\n' {
				i++
			}
			current.WriteByte('\n')
		case c == ';':
			flush()
		default:
			current.WriteByte(c)
		}
	}
	flush()
	return stmts
}
