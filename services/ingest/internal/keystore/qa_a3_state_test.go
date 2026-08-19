package keystore

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pricing"
)

// B3-1 — a quota crossing is NOT honored within the stated window when the
// workspace has more than one key.
//
// Workspace state refreshes only piggyback on a token-cache MISS: Workspace()
// returns early on a fresh token entry and never reaches refreshState. Token
// entries and the state entry each live keyCacheTTL, but a workspace's keys are
// first resolved at different moments, so the state entry expires while the key
// actually carrying traffic still has a fresh token entry. In that gap State()
// falls through to baseState — not over quota — and the workspace ingests
// everything, unsampled and uncounted.
//
// Postgres is up and answering over-quota throughout this test, so the D164(d)
// fail-open-on-outage narrowing does not cover it. What is being asserted is the
// D146/D166 statement the product makes out loud: a quota crossing is honored
// within flushInterval (5s) plus keyCacheTTL (30s).
//
// Reproduced against the running stack first (ws_qa_a3, two keys, free quota
// crossed by its own usage_ledger row): 43 s after the crossing, key B's export
// of 30 drop-vector spans was answered 200, added 0 to
// obstack_ingest_dropped_total{reason="quota"} and put all 30 spans in
// ClickHouse. Only at +62 s — when key B's own token entry expired — did
// sampling engage.
func TestQAA3QuotaCrossingIsHonoredForEveryKeyOfTheWorkspace(t *testing.T) {
	const (
		tokenA = "ok_qa_a3_a"
		tokenB = "ok_qa_a3_b"
		ws     = "ws_qa_a3"
	)

	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	overQuota := false
	stateCalls := 0

	s := newStore(
		func(_ context.Context, tokenHash string) (auth.Identity, bool, error) {
			switch tokenHash {
			case hashToken(tokenA):
				return auth.Identity{WorkspaceID: ws, KeyID: "key_qa_a3_a"}, true, nil
			case hashToken(tokenB):
				return auth.Identity{WorkspaceID: ws, KeyID: "key_qa_a3_b"}, true, nil
			}
			return auth.Identity{}, false, nil
		},
		func(_ context.Context, workspaceID string) (State, error) {
			stateCalls++
			return State{OverQuota: overQuota, Prices: pricing.Default}, nil
		},
	)
	s.now = func() time.Time { return now }
	advance := func(d time.Duration) { now = now.Add(d) }

	resolve := func(token string) {
		t.Helper()
		if _, err := s.Workspace(token); err != nil {
			t.Fatalf("Workspace(%s) = %v, want the key to resolve", token, err)
		}
	}

	// T0: key A carries the first export. State is read: under quota.
	resolve(tokenA)
	if stateCalls != 1 {
		t.Fatalf("state reads = %d after the first resolve, want 1", stateCalls)
	}
	if s.State(ws).OverQuota {
		t.Fatal("State reports over quota before the crossing; the rest of this test proves nothing")
	}

	// T0+2s: the workspace crosses its quota. Postgres would answer over-quota
	// to anyone who asked from here on — nothing about this is an outage.
	advance(2 * time.Second)
	overQuota = true

	// T0+25s: key B's first export. Its token entry is a miss and is now cached
	// for a further keyCacheTTL; the state entry, seeded at T0, is still fresh,
	// so the piggyback refresh is skipped.
	advance(23 * time.Second)
	resolve(tokenB)

	// T0+45s — 43 s after the crossing, well past flushInterval(5s) + keyCacheTTL
	// (30s). Key B keeps exporting; its token entry is still fresh.
	advance(20 * time.Second)
	resolve(tokenB)

	if !s.State(ws).OverQuota {
		t.Fatalf("43 s after the crossing State(%s).OverQuota = false, want true — "+
			"the state entry expired at T0+30s but key B's fresh token entry never "+
			"triggers refreshState, so an over-quota workspace ingests unsampled for "+
			"up to another keyCacheTTL (%s) past the stated window", ws, keyCacheTTL)
	}
}

// D196 singleflight, proven the only way a single fetch count can prove it:
// under N keys of one workspace all arriving on the cache-hit path with the
// state entry due, exactly one caller re-reads Postgres and the rest serve the
// entry already there. The refresh read is blocked so every caller is contending
// at once; if the singleflight were not per-workspace-keyed each concurrent
// caller would stampede a read of its own and the count would be N, not one.
// Red by removing the `s.refreshing[workspaceID]` guard from refreshState.
func TestQAA3StateRefreshIsSingleflightAcrossConcurrentCallers(t *testing.T) {
	const (
		tokenA = "ok_qa_a3_sf_a"
		tokenB = "ok_qa_a3_sf_b"
		ws     = "ws_qa_a3_sf"
	)
	const callers = 16

	base := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	var nowNanos atomic.Int64 // a clock the concurrent callers can read racelessly
	nowNanos.Store(base.UnixNano())
	setNow := func(d time.Duration) { nowNanos.Store(base.Add(d).UnixNano()) }

	var fetchCalls atomic.Int32
	var blocking atomic.Bool
	entered := make(chan struct{}, 1) // one signal: the single refresher has started its read
	release := make(chan struct{})    // held closed until the test lets that read finish

	s := newStore(
		func(_ context.Context, tokenHash string) (auth.Identity, bool, error) {
			switch tokenHash {
			case hashToken(tokenA):
				return auth.Identity{WorkspaceID: ws, KeyID: "key_sf_a"}, true, nil
			case hashToken(tokenB):
				return auth.Identity{WorkspaceID: ws, KeyID: "key_sf_b"}, true, nil
			}
			return auth.Identity{}, false, nil
		},
		func(_ context.Context, _ string) (State, error) {
			fetchCalls.Add(1)
			if blocking.Load() {
				entered <- struct{}{}
				<-release
			}
			return State{OverQuota: true, Prices: pricing.Default}, nil
		},
	)
	s.now = func() time.Time { return time.Unix(0, nowNanos.Load()).UTC() }

	// T0: key A seeds the state entry (expiry T0+30) and its own token entry.
	if _, err := s.Workspace(tokenA); err != nil {
		t.Fatalf("seed resolve of key A: %v", err)
	}
	// T0+20: key B's first read caches its token entry (expiry T0+50). The state
	// entry is still fresh, so no refresh — one fetch so far.
	setNow(20 * time.Second)
	if _, err := s.Workspace(tokenB); err != nil {
		t.Fatalf("seed resolve of key B: %v", err)
	}
	if got := fetchCalls.Load(); got != 1 {
		t.Fatalf("state fetches after seeding = %d, want 1 (key B's read found the state fresh)", got)
	}

	// T0+35: key B's token entry is still fresh but the state entry expired at
	// T0+30. Every one of `callers` concurrent key-B reads takes the cache-hit
	// path and finds the state due at once.
	setNow(35 * time.Second)
	blocking.Store(true)

	done := make(chan struct{}, callers)
	for range callers {
		go func() {
			if _, err := s.Workspace(tokenB); err != nil {
				t.Errorf("concurrent Workspace(key B) = %v, want the key to resolve", err)
			}
			done <- struct{}{}
		}()
	}

	// One caller wins the singleflight and is now blocked inside the read.
	<-entered

	// The other callers must not block behind it: they serve the existing entry
	// and return while the single read is still in flight. All but the one
	// refresher finish before we release the read.
	for range callers - 1 {
		<-done
	}
	if got := fetchCalls.Load(); got != 2 {
		t.Fatalf("state fetches under %d concurrent callers = %d, want 2 — one seed plus one "+
			"singleflight refresh; the rest must serve the stale entry, not each read Postgres", callers, got)
	}

	// Let the single refresher complete; it too returns.
	close(release)
	<-done

	if got := fetchCalls.Load(); got != 2 {
		t.Fatalf("state fetches after the refresher finished = %d, want 2", got)
	}
	// The one read that ran did land: the workspace now reads over quota.
	if !s.State(ws).OverQuota {
		t.Fatal("State(ws).OverQuota = false after the singleflight refresh, want true")
	}
}
