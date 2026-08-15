// Package migrate applies the obstack ClickHouse schema at service boot (D14).
// The embedded SQL files run in filename order and each applied file is recorded
// in obstack.schema_migrations, so a second boot is a no-op and an upgrade takes
// exactly the same path a first boot does. There is deliberately no
// docker-entrypoint-initdb.d: DDL that only ever runs against an empty volume is
// DDL that has never been tested on the case that matters.
package migrate

import (
	"context"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
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
func Run(ctx context.Context, dsn string, fsys fs.FS) ([]string, error) {
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
	defer conn.Close()

	if err := conn.Exec(ctx, "CREATE DATABASE IF NOT EXISTS "+Database); err != nil {
		return nil, fmt.Errorf("create database %s: %w", Database, err)
	}
	if err := conn.Exec(ctx, createSchemaMigrations); err != nil {
		return nil, fmt.Errorf("create %s.schema_migrations: %w", Database, err)
	}

	applied, err := appliedVersions(ctx, conn)
	if err != nil {
		return nil, err
	}

	names, err := fs.Glob(fsys, "*.sql")
	if err != nil {
		return nil, fmt.Errorf("list migrations: %w", err)
	}
	sort.Strings(names)

	var ran []string
	for _, name := range names {
		version := strings.TrimSuffix(name, ".sql")
		if _, done := applied[version]; done {
			continue
		}
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

func appliedVersions(ctx context.Context, conn driver.Conn) (map[string]struct{}, error) {
	rows, err := conn.Query(ctx, "SELECT version FROM "+Database+".schema_migrations")
	if err != nil {
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
