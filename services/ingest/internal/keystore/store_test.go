package keystore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pricing"
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

func (f *fakeLookup) fn(_ context.Context, tokenHash string) (auth.Identity, bool, error) {
	f.calls++
	if f.err != nil {
		return auth.Identity{}, false, f.err
	}
	ws, ok := f.rows[tokenHash]
	if !ok {
		return auth.Identity{}, false, nil
	}
	return auth.Identity{WorkspaceID: ws, KeyID: keyIDOf(ws)}, true, nil
}

// keyIDOf is the fake's stand-in for api_keys.id — one key per workspace is
// enough for what this file proves.
func keyIDOf(workspaceID string) string { return "key_" + workspaceID }

// fakeState is the other round trip: the two statements the workspace-state
// refresh runs, with the same three knobs.
type fakeState struct {
	rows  map[string]State // workspace → state
	calls int
	err   error
}

func (f *fakeState) fn(_ context.Context, workspaceID string) (State, error) {
	f.calls++
	if f.err != nil {
		return State{}, f.err
	}
	return f.rows[workspaceID], nil
}

func newTestStore(t *testing.T, rows map[string]string) (*Store, *fakeLookup, *fakeClock) {
	t.Helper()
	s, lookup, _, clock := newStateStore(t, rows, nil)
	return s, lookup, clock
}

func newStateStore(t *testing.T, rows map[string]string, states map[string]State) (*Store, *fakeLookup, *fakeState, *fakeClock) {
	t.Helper()

	hashed := make(map[string]string, len(rows))
	for token, ws := range rows {
		hashed[hashToken(token)] = ws
	}
	lookup := &fakeLookup{rows: hashed}
	state := &fakeState{rows: states}
	clock := &fakeClock{t: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)}

	s := newStore(lookup.fn, state.fn)
	s.now = clock.now
	return s, lookup, state, clock
}

func mustResolve(t *testing.T, s *Store, token, want string) {
	t.Helper()
	got, err := s.Workspace(token)
	if err != nil {
		t.Fatalf("Workspace(%q) error = %v, want %q", token, err, want)
	}
	if got.WorkspaceID != want {
		t.Fatalf("Workspace(%q) = %q, want %q", token, got.WorkspaceID, want)
	}
}

func mustRefuse(t *testing.T, s *Store, token string) {
	t.Helper()
	got, err := s.Workspace(token)
	if !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("Workspace(%q) = %+v, %v; want ErrUnauthorized", token, got, err)
	}
	if got != (auth.Identity{}) {
		t.Fatalf("Workspace(%q) refused but returned %+v, want the zero Identity", token, got)
	}
}

// isBaseState is the fail-open answer spelled out: not over quota, no
// overrides, so the embedded base price table applies. State holds a slice and
// so is not comparable; what "the zero State" means is worth naming anyway.
func isBaseState(s State) bool { return !s.OverQuota && s.Overrides == nil }

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
	if e, ok := s.cache[hashToken("ok_live_known")]; !ok || e.identity.WorkspaceID != "ws_a" {
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

// The seam receive authenticates through, wired the way main.go wires it. The
// identity comes back whole: the workspace the records are written into and the
// key that carried them, which is what the per-key health rows are written
// against (D100).
func TestStoreSatisfiesTheAuthResolver(t *testing.T) {
	s, _, _ := newTestStore(t, map[string]string{"ok_live_known": "ws_a"})
	a := auth.New(s)

	want := auth.Identity{WorkspaceID: "ws_a", KeyID: "key_ws_a"}
	if got, err := a.Workspace("Bearer ok_live_known"); err != nil || got != want {
		t.Fatalf("Workspace through the Authenticator = %+v, %v; want %+v", got, err, want)
	}
	if _, err := a.Workspace("Bearer ok_live_unknown"); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("unknown key error = %v, want ErrUnauthorized", err)
	}
}

// The workspace state rides the token round trip and costs no trip of its own
// (D164c): one refresh per TTL, on the same read that resolved the key, and
// nothing at all on a cache hit.
func TestWorkspaceStateRefreshesPiggybackOnTokenResolution(t *testing.T) {
	overrides := []pricing.Rate{{Match: "gpt-4o-mini", InputPerMTok: 0.11, OutputPerMTok: 0.44}}
	s, lookup, state, clock := newStateStore(t,
		map[string]string{"ok_live_known": "ws_a"},
		map[string]State{"ws_a": {OverQuota: true, Overrides: overrides}},
	)

	mustResolve(t, s, "ok_live_known", "ws_a")
	if lookup.calls != 1 || state.calls != 1 {
		t.Fatalf("lookup/state calls = %d/%d after the first resolve, want 1/1", lookup.calls, state.calls)
	}

	got := s.State("ws_a")
	if !got.OverQuota {
		t.Error("State reports under quota; the refresh read over-quota out of Postgres")
	}
	if len(got.Overrides) != 1 || got.Overrides[0] != overrides[0] {
		t.Errorf("State overrides = %+v, want %+v", got.Overrides, overrides)
	}

	// Inside the TTL nothing is asked again — neither statement.
	for range 20 {
		clock.advance(time.Second)
		mustResolve(t, s, "ok_live_known", "ws_a")
	}
	if lookup.calls != 1 || state.calls != 1 {
		t.Errorf("lookup/state calls = %d/%d inside the TTL, want 1/1", lookup.calls, state.calls)
	}

	// Past it, one token read carries one state refresh — the quota crossing is
	// honored within the same window revocation is.
	state.rows["ws_a"] = State{}
	clock.advance(keyCacheTTL)
	mustResolve(t, s, "ok_live_known", "ws_a")
	if lookup.calls != 2 || state.calls != 2 {
		t.Fatalf("lookup/state calls = %d/%d past the TTL, want 2/2", lookup.calls, state.calls)
	}
	if s.State("ws_a").OverQuota {
		t.Error("State still reports over quota after the refresh read it clear")
	}
}

// State is a map read and nothing else: the consume path calls it per request,
// so a Postgres round trip hiding in it would put the control plane back in the
// data path that the whole package exists to keep it out of.
func TestStateNeverQueries(t *testing.T) {
	s, _, state, _ := newStateStore(t,
		map[string]string{"ok_live_known": "ws_a"},
		map[string]State{"ws_a": {OverQuota: true}},
	)
	mustResolve(t, s, "ok_live_known", "ws_a")

	calls := state.calls
	for range 100 {
		s.State("ws_a")
		s.State("ws_never_authenticated")
	}
	if state.calls != calls {
		t.Errorf("State made %d queries, want none — it is a cache read", state.calls-calls)
	}
}

// The asymmetry, in one test because it is one decision (D164d): under the same
// Postgres outage, auth stays static — a key that resolved keeps resolving and
// an unknown one is still refused — while quota and overrides go open. Our
// outage must not sample away a paying customer's traces, and it must not hand
// an attacker a workspace either.
func TestQuotaFailsOpenWhileAuthFailsStatic(t *testing.T) {
	s, lookup, state, clock := newStateStore(t,
		map[string]string{"ok_live_known": "ws_a"},
		map[string]State{"ws_a": {
			OverQuota: true,
			Overrides: []pricing.Rate{{Match: "gpt-4o", InputPerMTok: 1, OutputPerMTok: 2}},
		}},
	)
	mustResolve(t, s, "ok_live_known", "ws_a")
	if !s.State("ws_a").OverQuota {
		t.Fatal("the workspace did not start out over quota; the rest of this test proves nothing")
	}

	down := errors.New("dial tcp 127.0.0.1:5432: connect: connection refused")
	lookup.err, state.err = down, down
	clock.advance(keyCacheTTL + time.Second)

	// Fail-static: the key keeps working, the unknown one keeps failing.
	mustResolve(t, s, "ok_live_known", "ws_a")
	mustRefuse(t, s, "ok_live_unknown")

	// Fail-open: the expired state reads back as the zero value — not over
	// quota, and no overrides, so the embedded base table prices the spans.
	got := s.State("ws_a")
	if got.OverQuota {
		t.Error("State still reports over quota with Postgres down; an outage of ours would start sampling a customer's traces")
	}
	if got.Overrides != nil {
		t.Errorf("State returned overrides %+v with Postgres down; base prices are the fail-open answer", got.Overrides)
	}

	// And a workspace whose state was never read at all is the same answer:
	// there is no cold-start case where quota degrades closed.
	if cold := s.State("ws_never_fetched"); !isBaseState(cold) {
		t.Errorf("State of an unseen workspace = %+v, want the zero State", cold)
	}

	// Postgres returning ends it, in the same one round trip.
	lookup.err, state.err = nil, nil
	state.rows["ws_a"] = State{OverQuota: true}
	clock.advance(keyCacheTTL + time.Second)
	mustResolve(t, s, "ok_live_known", "ws_a")
	if !s.State("ws_a").OverQuota {
		t.Error("State did not pick the over-quota verdict back up once Postgres returned")
	}
}
