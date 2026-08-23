package migrate

import (
	"reflect"
	"strings"
	"testing"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/migrations"
)

func TestSplitStatements(t *testing.T) {
	sql := `-- a comment; with a semicolon
CREATE TABLE t (c Enum8('a;b' = 0, 'c' = 1)) ENGINE = MergeTree ORDER BY c;

CREATE MATERIALIZED VIEW v TO t AS SELECT c FROM s;
`
	got := SplitStatements(sql)
	want := []string{
		"CREATE TABLE t (c Enum8('a;b' = 0, 'c' = 1)) ENGINE = MergeTree ORDER BY c",
		"CREATE MATERIALIZED VIEW v TO t AS SELECT c FROM s",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d statements %q, want %d", len(got), got, len(want))
	}
	for i := range want {
		if strings.TrimSpace(got[i]) != want[i] {
			t.Errorf("statement %d = %q, want %q", i, got[i], want[i])
		}
	}
}

// The embedded files are the artifact that actually ships; a stray semicolon
// would only surface at boot otherwise.
func TestEmbeddedMigrationsSplitAsExpected(t *testing.T) {
	counts := map[string]int{
		"0001_spans.sql":               1,
		"0002_logs.sql":                1,
		"0003_trace_summaries.sql":     2,
		"0004_retention_outer_ttl.sql": 3,
	}
	names, err := migrations.FS.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for _, e := range names {
		if !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		body, err := migrations.FS.ReadFile(e.Name())
		if err != nil {
			t.Fatal(err)
		}
		got[e.Name()] = len(SplitStatements(string(body)))
	}
	if !reflect.DeepEqual(got, counts) {
		t.Errorf("statement counts = %v, want %v", got, counts)
	}
}
