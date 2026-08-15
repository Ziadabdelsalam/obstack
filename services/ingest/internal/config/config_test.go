package config

import (
	"reflect"
	"testing"
)

func TestLoadDefaultsAndKeys(t *testing.T) {
	t.Setenv("CLICKHOUSE_DSN", "clickhouse://obstack_ingest:pw@clickhouse:9000/obstack")
	t.Setenv("OBSTACK_API_KEYS", "ok_dev_one:ws_a, ok_dev_two:ws_b ,ok_dev_three:ws_a")

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
			if _, err := Load(); err == nil {
				t.Fatal("Load succeeded, want error")
			}
		})
	}
}
