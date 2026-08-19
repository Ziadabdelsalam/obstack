package keystore

import (
	"context"
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
