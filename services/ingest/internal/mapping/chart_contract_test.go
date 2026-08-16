// K1: one definition. deploy/helm/obstack/ (T4) cannot reference files
// outside its own chart directory — Helm's `.Files` is chart-rooted — so the
// two D14/D11-binding artifacts it needs are physical copies rather than
// references:
//
//	deploy/compose/clickhouse/users.d/obstack-users.xml -> deploy/helm/obstack/files/obstack-users.xml
//	deploy/collector/config.yaml                        -> deploy/helm/obstack/files/collector-config.yaml
//
// A copy that is allowed to drift is the second, silently-diverging
// definition K1 already refused once (PR #3's layer vocabulary contract,
// alongside this file; S2.1 L2 — a cross-tree literal drifts outside the
// tree being edited). D40 rules the users copy pinned by a byte-equality
// test in this suite rather than regenerated at package time; the same
// reasoning applies to the collector config, which
// deploy/collector/README.md states as a byte-for-byte hand-off in exactly
// these words: "T4 packages this file, byte-for-byte, as the DaemonSet's
// ConfigMap; it is not re-derived there."
//
// Both pairs are read through repoRoot (layer_contract_test.go), the actual
// repo root rather than a relative guess, so the test finds both trees
// regardless of the working directory `go test` was invoked from.
package mapping_test

import (
	"os"
	"path/filepath"
	"testing"
)

// chartCopyPairs is the whole K1 contract this file checks: each source file
// and the chart's copy of it. Adding a third chart-packaged artifact means
// adding a row here, not a new test function.
var chartCopyPairs = []struct {
	name   string
	source string
	copy   string
}{
	{
		name:   "ClickHouse users (D11/D40)",
		source: filepath.Join("deploy", "compose", "clickhouse", "users.d", "obstack-users.xml"),
		copy:   filepath.Join("deploy", "helm", "obstack", "files", "obstack-users.xml"),
	},
	{
		name:   "obstack-collector DaemonSet config (T1/T4 hand-off)",
		source: filepath.Join("deploy", "collector", "config.yaml"),
		copy:   filepath.Join("deploy", "helm", "obstack", "files", "collector-config.yaml"),
	},
}

func TestChartFilesAreByteEqualToTheirSource(t *testing.T) {
	root := repoRoot(t)

	for _, pair := range chartCopyPairs {
		t.Run(pair.name, func(t *testing.T) {
			source, err := os.ReadFile(filepath.Join(root, pair.source))
			if err != nil {
				t.Fatalf("read %s: %v", pair.source, err)
			}
			chartCopy, err := os.ReadFile(filepath.Join(root, pair.copy))
			if err != nil {
				t.Fatalf("read %s: %v", pair.copy, err)
			}

			if string(source) != string(chartCopy) {
				t.Fatalf("%s is not byte-equal to %s — K1 refuses a second, drifting definition; copy %s over %s and re-run",
					pair.copy, pair.source, pair.source, pair.copy)
			}
		})
	}
}
