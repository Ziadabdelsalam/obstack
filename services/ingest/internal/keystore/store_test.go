package keystore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/pgmigrations"
)

// The cache is what decides who is authorised while Postgres is unreachable, so
// its semantics are proven here — with no database, at a clock a test can move,
// because a 30 s TTL and a Postgres outage are not things an integration test
// can wait for. integration_test.go proves the same rules against a real server
// through the real query.

// fakeClock stands in for time.Now so a TTL can be crossed in a nanosecond.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

// fakeLookup is one Postgres round trip: what it answers, how often it was
// asked, and whether it is currently failing.
type fakeLookup struct {
	rows  map[string]string // token hash → workspace
	calls int
	err   error
}

func (f *fakeLookup) fn(_ context.Context, tokenHash string) (string, bool, error) {
	f.calls++
	if f.err != nil {
		return "", false, f.err
	}
	ws, ok := f.rows[tokenHash]
	return ws, ok, nil
}

func newTestStore(t *testing.T, rows map[string]string) (*Store, *fakeLookup, *fakeClock) {
	t.Helper()

	hashed := make(map[string]string, len(rows))
	for token, ws := range rows {
		hashed[hashToken(token)] = ws
	}
	lookup := &fakeLookup{rows: hashed}
	clock := &fakeClock{t: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)}

	s := newStore(lookup.fn)
	s.now = clock.now
	return s, lookup, clock
}

func mustResolve(t *testing.T, s *Store, token, want string) {
	t.Helper()
	got, err := s.Workspace(token)
	if err != nil {
		t.Fatalf("Workspace(%q) error = %v, want %q", token, err, want)
	}
	if got != want {
		t.Fatalf("Workspace(%q) = %q, want %q", token, got, want)
	}
}

func mustRefuse(t *testing.T, s *Store, token string) {
	t.Helper()
	got, err := s.Workspace(token)
	if !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("Workspace(%q) = %q, %v; want ErrUnauthorized", token, got, err)
	}
}

// The D139 cross-language vectors, BOTH of them (D139 as amended). They are
// pinned in both this suite and the web app's for one reason: two languages
// implement this hash, and a row written by one has to resolve through the
// other. A change here that is not a change there is a fleet of keys that stop
// working. The ASCII vector alone cannot catch an encoding swap, which is why
// the non-ASCII one stands beside it — an implementation meets both or fails.
func TestHashTokenMatchesThePinnedVector(t *testing.T) {
	const (
		token = "ok_dev_local"
		want  = "45880674fdc48bbcd49721bf6ac190e804836ca4fcd54c736c604153f4947e20"
	)
	if got := hashToken(token); got != want {
		t.Fatalf("hashToken(%q) = %q, want %q", token, got, want)
	}

	// The encoding half of the same contract: SHA-256 over the UTF-8 bytes.
	// `printf 'ok_live_\xc3\xa9' | shasum -a 256` is this value; a hash taken
	// over UTF-16 or latin1 bytes is a different one, and that is exactly how a
	// key issued by the web app would stop resolving here with the ASCII vector
	// still green.
	const (
		utf8Token = "ok_live_é"
		utf8Want  = "e9d4d753fa6e21f9da99b36f719d76ad9d01526bf9b47fcf2c5b1925a0b458db"
	)
	if got := hashToken(utf8Token); got != utf8Want {
		t.Fatalf("hashToken(%q) = %q, want %q", utf8Token, got, utf8Want)
	}

	// And the seeded continuity row carries that exact hash, so the credential
	// the collector and every signed harness send resolves through this code.
	seed, err := pgmigrations.FS.ReadFile("0004_api_keys.sql")
	if err != nil {
		t.Fatalf("read the api_keys migration: %v", err)
	}
	if !strings.Contains(string(seed), want) {
		t.Errorf("0004_api_keys.sql does not seed SHA-256(%q); the dev key would 401 against a migrated database", token)
	}
}

// Ingest never validates token shape (D139): it hashes what it was given and
// asks Postgres. A store that rejected anything but `ok_live_…` would break the
// dev row on the way to enforcing nothing — an attacker picks their own shape.
func TestWorkspaceIsShapeAgnostic(t *testing.T) {
	issued := "ok_live_" + strings.Repeat("a", 64)
	s, _, _ := newTestStore(t, map[string]string{
		"ok_dev_local":       "ws_demo",
		issued:               "ws_signed_up",
		"nothing-like-a-key": "ws_odd",
	})

	mustResolve(t, s, "ok_dev_local", "ws_demo")
	mustResolve(t, s, issued, "ws_signed_up")
	mustResolve(t, s, "nothing-like-a-key", "ws_odd")
}

// Read-through, both classes: the answer is cached and the round trip is not
// repeated. Per-request round trips are the thing this package exists to refuse.
func TestLookupsAreCachedPositiveAndNegative(t *testing.T) {
	s, lookup, _ := newTestStore(t, map[string]string{"ok_live_known": "ws_a"})

	for range 5 {
		mustResolve(t, s, "ok_live_known", "ws_a")
		mustRefuse(t, s, "ok_live_unknown")
	}
	if lookup.calls != 2 {
		t.Errorf("lookup called %d times for two distinct tokens, want 2 — one per token per TTL", lookup.calls)
	}
}

// The TTL is a bound on staleness, and a hit does not extend it: a key that is
// asked about constantly is exactly the key whose revocation must not be
// deferred forever.
func TestEntriesExpireAndHitsDoNotExtendThem(t *testing.T) {
	s, lookup, clock := newTestStore(t, map[string]string{"ok_live_known": "ws_a"})

	mustResolve(t, s, "ok_live_known", "ws_a")
	// Kept hot across the whole TTL, one hit per second.
	for range 29 {
		clock.advance(time.Second)
		mustResolve(t, s, "ok_live_known", "ws_a")
	}
	if lookup.calls != 1 {
		t.Fatalf("lookup called %d times inside the TTL, want 1", lookup.calls)
	}

	// Revoked in Postgres, which the cache cannot know until it re-reads.
	delete(lookup.rows, hashToken("ok_live_known"))
	mustResolve(t, s, "ok_live_known", "ws_a")

	clock.advance(time.Second)
	mustRefuse(t, s, "ok_live_known")
	if lookup.calls != 2 {
		t.Errorf("lookup called %d times, want a second read once the entry aged past keyCacheTTL", lookup.calls)
	}
	if keyCacheTTL != 30*time.Second {
		t.Errorf("keyCacheTTL = %v; the revocation window this test walks, and the one the product documents, is 30s", keyCacheTTL)
	}
}

// Fail-static, the property the whole cache is shaped around: a Postgres we
// cannot reach must not become a customer outage, and must not become a
// blanket-accept either.
func TestFailStatic(t *testing.T) {
	s, lookup, clock := newTestStore(t, map[string]string{"ok_live_known": "ws_a"})

	mustResolve(t, s, "ok_live_known", "ws_a")
	mustRefuse(t, s, "ok_live_unknown")
	lookup.err = errors.New("dial tcp 127.0.0.1:5432: connect: connection refused")
	clock.advance(keyCacheTTL + time.Second)

	t.Run("a resolved key keeps resolving", func(t *testing.T) {
		mustResolve(t, s, "ok_live_known", "ws_a")
		// Twice: the failed read must not have evicted the entry it could not
		// refresh, or the second request would 401 where the first did not.
		mustResolve(t, s, "ok_live_known", "ws_a")
	})

	t.Run("an unknown key is still refused", func(t *testing.T) {
		mustRefuse(t, s, "ok_live_unknown")    // negative entry, expired
		mustRefuse(t, s, "ok_live_never_seen") // cold, nothing to fall back to
	})

	t.Run("Postgres returning ends the staleness", func(t *testing.T) {
		lookup.err = nil
		delete(lookup.rows, hashToken("ok_live_known"))
		mustRefuse(t, s, "ok_live_known")
	})
}

// The bound is on the cache as a whole, and it is the negative half it exists
// for: unknown tokens arrive as fast as an attacker can generate them, and must
// never be able to push out the keys a Postgres outage would then leave
// unserved.
func TestCacheBoundKeepsPositiveEntries(t *testing.T) {
	s, lookup, _ := newTestStore(t, map[string]string{"ok_live_known": "ws_a"})

	for i := range keyCacheMaxEntries {
		mustRefuse(t, s, fmt.Sprintf("ok_live_unknown_%d", i))
	}
	if len(s.cache) != keyCacheMaxEntries {
		t.Fatalf("cache holds %d entries, want the cap %d", len(s.cache), keyCacheMaxEntries)
	}

	// A valid key arriving at a full cache is stored anyway, against a negative.
	mustResolve(t, s, "ok_live_known", "ws_a")
	if len(s.cache) > keyCacheMaxEntries {
		t.Errorf("cache grew to %d entries past the cap, want a negative evicted for the positive", len(s.cache))
	}
	if e, ok := s.cache[hashToken("ok_live_known")]; !ok || e.workspaceID != "ws_a" {
		t.Error("the valid key was not cached at the cap; a Postgres outage would 401 it")
	}

	// A further unknown key is answered but not stored, so the cap holds.
	before := len(s.cache)
	calls := lookup.calls
	mustRefuse(t, s, "ok_live_one_too_many")
	mustRefuse(t, s, "ok_live_one_too_many")
	if len(s.cache) > before {
		t.Errorf("cache grew to %d entries; a new negative at the cap must be dropped, not stored", len(s.cache))
	}
	if lookup.calls != calls+2 {
		t.Errorf("lookup called %d times for the uncached negative, want one per request — that is the cost of the cap", lookup.calls-calls)
	}
}

// The seam receive authenticates through, wired the way main.go wires it.
func TestStoreSatisfiesTheAuthResolver(t *testing.T) {
	s, _, _ := newTestStore(t, map[string]string{"ok_live_known": "ws_a"})
	a := auth.New(s)

	if got, err := a.Workspace("Bearer ok_live_known"); err != nil || got != "ws_a" {
		t.Fatalf("Workspace through the Authenticator = %q, %v; want ws_a", got, err)
	}
	if _, err := a.Workspace("Bearer ok_live_unknown"); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("unknown key error = %v, want ErrUnauthorized", err)
	}
}
