package config

import "testing"

// Every default at once, as an equality: the environment is read only for what
// Config carries, and the key map that used to be loaded here is deleted (D98)
// — this is what its absence looks like, a Load with nothing in the environment
// but the DSN. The boot flag is set rather than assumed, because unset is a
// default under test and the developer's own shell must not decide what it is.
func TestLoadDefaults(t *testing.T) {
	t.Setenv("CLICKHOUSE_DSN", "clickhouse://obstack_ingest:pw@clickhouse:9000/obstack")
	t.Setenv("OBSTACK_MIGRATE_ON_BOOT", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := Config{
		ClickHouseDSN: "clickhouse://obstack_ingest:pw@clickhouse:9000/obstack",
		OTLPGRPCAddr:  ":4317",
		OTLPHTTPAddr:  ":4318",
		AdminAddr:     DefaultAdminAddr,
		MigrateOnBoot: true,
	}
	if cfg != want {
		t.Errorf("Load = %+v, want %+v", cfg, want)
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

// The migrate subcommand's loader takes the DSN and nothing else, and says so
// when it is missing: a Job that fails has to name the variable to go set.
func TestLoadDSN(t *testing.T) {
	t.Setenv("CLICKHOUSE_DSN", "clickhouse://obstack_ingest:pw@clickhouse:9000/obstack")

	dsn, err := LoadDSN()
	if err != nil {
		t.Fatalf("LoadDSN: %v", err)
	}
	if want := "clickhouse://obstack_ingest:pw@clickhouse:9000/obstack"; dsn != want {
		t.Errorf("LoadDSN = %q, want %q", dsn, want)
	}

	t.Setenv("CLICKHOUSE_DSN", "")
	if _, err := LoadDSN(); err == nil {
		t.Error("LoadDSN succeeded with no CLICKHOUSE_DSN, want error")
	}
}

func TestLoadRejectsIncompleteEnv(t *testing.T) {
	t.Setenv("CLICKHOUSE_DSN", "")
	t.Setenv("OBSTACK_MIGRATE_ON_BOOT", "")
	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with no CLICKHOUSE_DSN, want error")
	}
}
