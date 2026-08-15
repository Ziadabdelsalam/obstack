package config

import (
	"reflect"
	"testing"
)

func TestLoadDefaultsAndKeys(t *testing.T) {
	t.Setenv("CLICKHOUSE_DSN", "clickhouse://obstack_ingest:pw@clickhouse:9000/obstack")
	t.Setenv("OBSTACK_API_KEYS", "ok_dev_one:ws_a, ok_dev_two:ws_b ,ok_dev_three:ws_a")
	// Set rather than assumed: unset is a default under test, and the developer's
	// own shell must not be able to decide what it is.
	t.Setenv("OBSTACK_MIGRATE_ON_BOOT", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got, want := cfg.APIKeys["ok_dev_two"], "ws_b"; got != want {
		t.Errorf("APIKeys[ok_dev_two] = %q, want %q", got, want)
	}
	if got, want := cfg.WorkspaceIDs(), []string{"ws_a", "ws_b"}; !reflect.DeepEqual(got, want) {
		t.Errorf("WorkspaceIDs() = %v, want %v", got, want)
	}
	if got, want := cfg.OTLPGRPCAddr, ":4317"; got != want {
		t.Errorf("OTLPGRPCAddr = %q, want %q", got, want)
	}
	if got, want := cfg.AdminAddr, ":8080"; got != want {
		t.Errorf("AdminAddr = %q, want %q", got, want)
	}
	// Unset means the serving process still owns the schema, so compose and
	// every single-node self-hoster keep the behaviour they already have.
	if !cfg.MigrateOnBoot {
		t.Error("MigrateOnBoot = false with the variable unset, want true")
	}
}

func TestLoadMigrateOnBoot(t *testing.T) {
	for _, tc := range []struct {
		raw     string
		want    bool
		wantErr bool
	}{
		{raw: "", want: true},
		{raw: "false", want: false},
		{raw: "0", want: false},
		{raw: "true", want: true},
		// A typo must not silently move who owns the schema.
		{raw: "ture", wantErr: true},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			t.Setenv("CLICKHOUSE_DSN", "clickhouse://x@y:9000/obstack")
			t.Setenv("OBSTACK_API_KEYS", "ok_dev_one:ws_a")
			t.Setenv("OBSTACK_MIGRATE_ON_BOOT", tc.raw)

			cfg, err := Load()
			if tc.wantErr {
				if err == nil {
					t.Fatalf("Load(%q) succeeded, want error", tc.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load(%q): %v", tc.raw, err)
			}
			if cfg.MigrateOnBoot != tc.want {
				t.Errorf("MigrateOnBoot = %v, want %v", cfg.MigrateOnBoot, tc.want)
			}
		})
	}
}

// The migrate subcommand's loader takes the DSN and nothing else: a process that
// only runs DDL must not need the ingest bearer keys in its environment.
func TestLoadDSNIgnoresAPIKeys(t *testing.T) {
	t.Setenv("OBSTACK_API_KEYS", "")
	t.Setenv("CLICKHOUSE_DSN", "clickhouse://obstack_ingest:pw@clickhouse:9000/obstack")

	dsn, err := LoadDSN()
	if err != nil {
		t.Fatalf("LoadDSN: %v", err)
	}
	if want := "clickhouse://obstack_ingest:pw@clickhouse:9000/obstack"; dsn != want {
		t.Errorf("LoadDSN = %q, want %q", dsn, want)
	}
	if _, err := Load(); err == nil {
		t.Error("Load succeeded without OBSTACK_API_KEYS, so LoadDSN proves nothing")
	}

	t.Setenv("CLICKHOUSE_DSN", "")
	if _, err := LoadDSN(); err == nil {
		t.Error("LoadDSN succeeded with no CLICKHOUSE_DSN, want error")
	}
}

func TestLoadRejectsIncompleteEnv(t *testing.T) {
	for _, tc := range []struct{ name, dsn, keys string }{
		{"no dsn", "", "ok_dev_one:ws_a"},
		{"no keys", "clickhouse://x@y:9000/obstack", ""},
		{"malformed key", "clickhouse://x@y:9000/obstack", "ok_dev_one"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CLICKHOUSE_DSN", tc.dsn)
			t.Setenv("OBSTACK_API_KEYS", tc.keys)
			t.Setenv("OBSTACK_MIGRATE_ON_BOOT", "")
			if _, err := Load(); err == nil {
				t.Fatal("Load succeeded, want error")
			}
		})
	}
}
