// Package config loads the ingest service's runtime configuration from the
// environment (D2). Everything the service needs comes from env so the same
// image runs unchanged in compose, in Kubernetes, and in obstack cloud.
package config

import (
	"fmt"
	"os"
	"sort"
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

	// APIKeys maps a bearer key to the workspace it writes into (D4). In
	// Phase 1 this comes from env; in M3 only the lookup moves to Postgres,
	// the wire format is unchanged.
	APIKeys map[string]string

	OTLPGRPCAddr string
	OTLPHTTPAddr string

	// AdminAddr serves /healthz and /metrics.
	AdminAddr string
}

// Load reads and validates the environment. It fails rather than defaulting on
// anything that would let the service boot into a useless state: a missing DSN
// means no writes, and a missing key set means every request is a 401.
func Load() (Config, error) {
	dsn := os.Getenv("CLICKHOUSE_DSN")
	if dsn == "" {
		return Config{}, fmt.Errorf("CLICKHOUSE_DSN is required")
	}

	keys, err := parseAPIKeys(os.Getenv("OBSTACK_API_KEYS"))
	if err != nil {
		return Config{}, err
	}

	return Config{
		ClickHouseDSN: dsn,
		APIKeys:       keys,
		OTLPGRPCAddr:  envOr("OBSTACK_OTLP_GRPC_ADDR", ":4317"),
		OTLPHTTPAddr:  envOr("OBSTACK_OTLP_HTTP_ADDR", ":4318"),
		AdminAddr:     envOr("OBSTACK_ADMIN_ADDR", DefaultAdminAddr),
	}, nil
}

// WorkspaceIDs returns the distinct workspaces this process accepts data for,
// sorted. Used to pre-create the per-workspace metric series at boot.
func (c Config) WorkspaceIDs() []string {
	seen := make(map[string]struct{}, len(c.APIKeys))
	for _, ws := range c.APIKeys {
		seen[ws] = struct{}{}
	}
	ids := make([]string, 0, len(seen))
	for ws := range seen {
		ids = append(ids, ws)
	}
	sort.Strings(ids)
	return ids
}

// parseAPIKeys reads the D4 format: `ok_dev_<rand>:<workspace_id>[,…]`.
func parseAPIKeys(raw string) (map[string]string, error) {
	keys := map[string]string{}
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		key, workspace, ok := strings.Cut(pair, ":")
		if !ok || key == "" || workspace == "" {
			return nil, fmt.Errorf("OBSTACK_API_KEYS entry %q is not key:workspace_id", pair)
		}
		keys[key] = workspace
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("OBSTACK_API_KEYS is required, as key:workspace_id[,…]")
	}
	return keys, nil
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
