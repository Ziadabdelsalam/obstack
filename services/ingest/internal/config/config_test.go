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

// D275: the chart's `existingSecret` path hands this process a DSN with no
// password in it and the password separately, via secretKeyRef into
// OBSTACK_CLICKHOUSE_DSN_PASSWORD. LoadDSN has to fold the two back into one
// connection string.
func TestLoadDSNInjectsPassword(t *testing.T) {
	t.Setenv("CLICKHOUSE_DSN", "clickhouse://obstack_ingest@clickhouse:9000/obstack")
	t.Setenv("OBSTACK_CLICKHOUSE_DSN_PASSWORD", "s3cret")

	dsn, err := LoadDSN()
	if err != nil {
		t.Fatalf("LoadDSN: %v", err)
	}
	if want := "clickhouse://obstack_ingest:s3cret@clickhouse:9000/obstack"; dsn != want {
		t.Errorf("LoadDSN = %q, want %q", dsn, want)
	}
}

// Additive per D275: a chart that never sets the password env (today's
// default, chart-owned-Secret posture) must see the DSN it was given pass
// through untouched, password embedded or not.
func TestInjectDSNPasswordNoopWhenEnvUnset(t *testing.T) {
	t.Setenv("OBSTACK_CLICKHOUSE_DSN_PASSWORD", "")
	const dsn = "clickhouse://obstack_ingest:dev@clickhouse:9000/obstack"

	got, err := InjectDSNPassword(dsn, "OBSTACK_CLICKHOUSE_DSN_PASSWORD")
	if err != nil {
		t.Fatalf("InjectDSNPassword: %v", err)
	}
	if got != dsn {
		t.Errorf("InjectDSNPassword = %q, want unchanged %q", got, dsn)
	}
}

func TestInjectDSNPasswordSetsPassword(t *testing.T) {
	t.Setenv("OBSTACK_POSTGRES_DSN_PASSWORD", "rotated")

	got, err := InjectDSNPassword("postgres://obstack@postgres:5432/obstack", "OBSTACK_POSTGRES_DSN_PASSWORD")
	if err != nil {
		t.Fatalf("InjectDSNPassword: %v", err)
	}
	if want := "postgres://obstack:rotated@postgres:5432/obstack"; got != want {
		t.Errorf("InjectDSNPassword = %q, want %q", got, want)
	}
}

// A DSN this malformed is a configuration mistake, reported by the variable
// name an operator goes and fixes rather than a parse error three frames deep.
func TestInjectDSNPasswordRejectsUnparseableDSN(t *testing.T) {
	t.Setenv("OBSTACK_POSTGRES_DSN_PASSWORD", "pw")

	// A port url.Parse actually rejects, not merely an odd-looking string:
	// url.Parse accepts `not a dsn` as a relative path with no error, so a
	// test using that would assert the no-username branch below all over
	// again and never reach the parse error at all.
	if _, err := InjectDSNPassword("postgres://obstack@postgres:not-a-port/obstack", "OBSTACK_POSTGRES_DSN_PASSWORD"); err == nil {
		t.Error("InjectDSNPassword accepted an unparseable dsn, want error")
	}
}

// A password with nothing to attach to (no username in the DSN) is also a
// configuration mistake, not a value to silently drop.
func TestInjectDSNPasswordRequiresAUsername(t *testing.T) {
	t.Setenv("OBSTACK_POSTGRES_DSN_PASSWORD", "pw")

	if _, err := InjectDSNPassword("postgres://postgres:5432/obstack", "OBSTACK_POSTGRES_DSN_PASSWORD"); err == nil {
		t.Error("InjectDSNPassword accepted a dsn with no username, want error")
	}
}
