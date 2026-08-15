// Package migrations embeds the obstack ClickHouse schema. The SQL ships inside
// the binary (D2) so the image that serves traffic is also the image that owns
// the DDL — there is no docker-entrypoint-initdb.d and no separate migrate step.
package migrations

import "embed"

// FS holds the migration files, applied in filename order by internal/migrate.
//
//go:embed *.sql
var FS embed.FS
