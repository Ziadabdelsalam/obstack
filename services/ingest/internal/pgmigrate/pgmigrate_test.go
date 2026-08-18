package pgmigrate

import (
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/pgmigrations"
)

// versionPattern is the naming the glob embed rests on: filename order is
// version order only while every file starts with a fixed-width number.
var versionPattern = regexp.MustCompile(`^[0-9]{4}_[a-z0-9_]+\.sql$`)

// embeddedVersions is what the binary carries, in the order Run would apply it.
// The integration tests compare against this rather than a hard-coded list so a
// migration added later — 0003 and everything after it — is covered by the same
// assertions without editing them.
func embeddedVersions(t *testing.T) []string {
	t.Helper()

	entries, err := pgmigrations.FS.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var versions []string
	for _, e := range entries {
		if !versionPattern.MatchString(e.Name()) {
			t.Errorf("embedded migration %q does not match %s — filename order is what orders the set", e.Name(), versionPattern)
			continue
		}
		versions = append(versions, strings.TrimSuffix(e.Name(), ".sql"))
	}
	sort.Strings(versions)
	return versions
}

// The embed is a glob, so adding a migration is adding a file. This asserts the
// consequence rather than the directive: the set the binary carries is whatever
// is on disk, with nothing to keep in step by hand.
func TestEmbeddedSetIsWhateverIsOnDisk(t *testing.T) {
	got := embeddedVersions(t)
	// The two this package ships with; a later migration joins the tail and
	// must not require this list to grow.
	want := []string{"0001_workspaces", "0002_saved_views"}
	if len(got) < len(want) {
		t.Fatalf("embedded versions = %v, want at least %v", got, want)
	}
	if !reflect.DeepEqual(got[:len(want)], want) {
		t.Errorf("embedded versions start with %v, want %v", got[:len(want)], want)
	}
}

// Every integration test below skips when no Postgres is reachable, so the
// configuration failure — the one an operator meets first — is proven without
// one. A DSN this malformed never reaches a socket, which is what makes the
// assertion about the message rather than about the network.
func TestAMalformedDSNNamesTheVariable(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func() error
	}{
		{"Run", func() error { _, err := Run(t.Context(), "not-a-dsn", pgmigrations.FS); return err }},
		{"Pending", func() error { _, err := Pending(t.Context(), "not-a-dsn", pgmigrations.FS); return err }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			if err == nil {
				t.Fatalf("%s accepted an unparseable DSN, want error", tc.name)
			}
			if !strings.Contains(err.Error(), "OBSTACK_POSTGRES_DSN") {
				t.Errorf("error = %v, want it to name the variable to go fix", err)
			}
		})
	}
}
