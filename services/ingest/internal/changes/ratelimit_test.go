package changes

import (
	"testing"
	"time"
)

func TestLimiterAllowsSixtyAMinutePerWorkspace(t *testing.T) {
	l := NewLimiter()
	t0 := testNow
	for i := 0; i < 60; i++ {
		if !l.Allow("ws_a", t0) {
			t.Fatalf("post %d of 60 refused", i+1)
		}
	}
	if l.Allow("ws_a", t0) {
		t.Fatal("the 61st post in the same instant was allowed")
	}
	// Independent per workspace.
	if !l.Allow("ws_b", t0) {
		t.Fatal("another workspace's first post was refused by ws_a's cap")
	}
	// One token a second refills: one more after a second, not two.
	if !l.Allow("ws_a", t0.Add(time.Second)) {
		t.Fatal("no refill after one second")
	}
	if l.Allow("ws_a", t0.Add(time.Second)) {
		t.Fatal("two tokens refilled in one second")
	}
	// A full minute later the burst is back, and no more than the burst.
	t1 := t0.Add(2 * time.Minute)
	for i := 0; i < 60; i++ {
		if !l.Allow("ws_a", t1) {
			t.Fatalf("post %d refused after a full refill", i+1)
		}
	}
	if l.Allow("ws_a", t1) {
		t.Fatal("refill exceeded the burst")
	}
}

func TestLimiterPrunesIdleBuckets(t *testing.T) {
	l := NewLimiter()
	t0 := testNow
	for i := 0; i < pruneAbove+1; i++ {
		l.Allow("ws_"+string(rune('a'+i%26))+time.Duration(i).String(), t0)
	}
	if got := l.size(); got != pruneAbove+1 {
		t.Fatalf("buckets = %d, want %d before any prune", got, pruneAbove+1)
	}
	// Two minutes later every bucket is full again, so a call that crosses
	// the threshold prunes them all but its own.
	l.Allow("ws_new", t0.Add(2*time.Minute))
	if got := l.size(); got != 1 {
		t.Errorf("buckets after prune = %d, want 1 (only the live one)", got)
	}
}
