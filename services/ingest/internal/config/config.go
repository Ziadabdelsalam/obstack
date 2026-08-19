// Package config loads the ingest service's runtime configuration from the
// environment (D2). Everything the service needs comes from env so the same
// image runs unchanged in compose, in Kubernetes, and in obstack cloud.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// DefaultAdminAddr is where /healthz and /metrics listen unless
// OBSTACK_ADMIN_ADDR says otherwise. The healthcheck probe in cmd/ingest reads
// the same constant, so the served port and the probed port cannot drift.
const DefaultAdminAddr = ":8080"

// Config is the fully validated configuration of one ingest process.
type Config struct {
	// ClickHouseDSN addresses the write user, e.g.
	// clickhouse://obstack_ingest:pw@clickhouse:9000/obstack.
	ClickHouseDSN string

	OTLPGRPCAddr string
	OTLPHTTPAddr string

	// AdminAddr serves /healthz and /metrics.
	AdminAddr string

	// MigrateOnBoot decides whether this process applies the schema or only
	// verifies it. True — the default — is compose and every single-node
	// self-hoster, where the serving container is the only migration runner
	// there is. Kubernetes sets it false on the Deployment and applies the
	// schema from a pre-upgrade Job running `ingest migrate`, so N replicas
	// never race on DDL. False is not "skip": the process still refuses to
	// serve a schema that is behind its own migrations.
	MigrateOnBoot bool
}

// Load reads and validates the environment. It fails rather than defaulting on
// anything that would let the service boot into a useless state: a missing DSN
// means no writes.
//
// There are no API keys here any more: the OBSTACK_API_KEYS variable is deleted
// (D98). Keys are Postgres rows read through internal/keystore, which is the
// only lookup path there is — an env map beside it would be a second answer to
// the same question, and the two would eventually disagree.
func Load() (Config, error) {
	dsn, err := LoadDSN()
	if err != nil {
		return Config{}, err
	}

	migrateOnBoot, err := EnvBool("OBSTACK_MIGRATE_ON_BOOT", true)
	if err != nil {
		return Config{}, err
	}

	return Config{
		ClickHouseDSN: dsn,
		OTLPGRPCAddr:  envOr("OBSTACK_OTLP_GRPC_ADDR", ":4317"),
		OTLPHTTPAddr:  envOr("OBSTACK_OTLP_HTTP_ADDR", ":4318"),
		AdminAddr:     envOr("OBSTACK_ADMIN_ADDR", DefaultAdminAddr),
		MigrateOnBoot: migrateOnBoot,
	}, nil
}

// LoadDSN reads the one variable a migrations-only process needs. The `migrate`
// subcommand goes through here rather than Load because everything else Load
// validates — the listen addresses, the boot flag deciding who owns the schema —
// belongs to serving traffic, and a Job that applies DDL and exits should not
// fail on a validator it never consults.
func LoadDSN() (string, error) {
	dsn := os.Getenv("CLICKHOUSE_DSN")
	if dsn == "" {
		return "", fmt.Errorf("CLICKHOUSE_DSN is required")
	}
	return dsn, nil
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// EnvBool returns an error where envOr silently falls back, because a boolean
// that coerced `ture` to false would quietly change which process owns the
// schema and the operator would learn about it from a broken query, not a log
// line. Empty still means unset, as everywhere else here.
//
// Exported because the Postgres boot flag lives in package main — its DSN is
// deliberately not a Config field (see cmd/ingest/main.go) — and two copies of
// "which value stops boot" is exactly the drift this function exists to refuse.
func EnvBool(name string, fallback bool) (bool, error) {
	// Trimmed before parsing, but no more forgiving than that: a YAML block
	// scalar or a hand-edited .env trivially leaves a trailing space, and
	// refusing to boot over one is a false positive. `ture` still fails — the
	// strictness that matters is about intent, not formatting.
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return fallback, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false, got %q", name, v)
	}
	return b, nil
}
