// Package pgmigrations embeds the obstack Postgres schema — workspaces, saved
// views, and the better-auth tables captured into this set rather than applied
// by the library. It ships inside the ingest binary for the same reason the
// ClickHouse set does (D2): the process that owns the schema is a process the
// deployment already runs.
package pgmigrations

import "embed"

// FS holds the migration files, applied in filename order by internal/pgmigrate.
//
// The embed is a glob rather than a list of names so a new migration is a new
// file and nothing else — there is no second place to remember to edit, and no
// way to add SQL that the binary silently does not carry.
//
//go:embed *.sql
var FS embed.FS
