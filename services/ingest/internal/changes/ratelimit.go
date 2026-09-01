package changes

import (
	"sync"
	"time"
)

// The per-workspace cap (D498): 60 events a minute sustained, a burst of 60.
// Refused, not sampled — an annotation feed is not a firehose, and a refused
// write is honest where a silently thinned one is not. The bucket is per
// process: N replicas hold N buckets, so the effective cap is N×, stated in
// the packet and acceptable for a guard that is not a billing unit.
const (
	burst      = 60
	refillRate = float64(burst) / 60 // tokens per second
	// pruneAbove bounds the map: past it, every full (idle) bucket is dropped
	// on the next call. A workspace that posts again simply gets a fresh full
	// bucket, which is the state an idle one is in anyway.
	pruneAbove = 10_000
)

// Limiter is a token bucket per workspace, safe for concurrent use.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

// NewLimiter returns an empty limiter; every workspace starts with a full burst.
func NewLimiter() *Limiter {
	return &Limiter{buckets: map[string]*bucket{}}
}

// Allow takes one token from the workspace's bucket if one is there.
func (l *Limiter) Allow(workspaceID string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[workspaceID]
	if !ok {
		if len(l.buckets) >= pruneAbove {
			l.prune(now)
		}
		b = &bucket{tokens: burst, last: now}
		l.buckets[workspaceID] = b
	}
	b.refill(now)
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (b *bucket) refill(now time.Time) {
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = min(burst, b.tokens+elapsed*refillRate)
		b.last = now
	}
}

// prune drops every bucket that would be full at now — the idle ones. Called
// with the lock held.
func (l *Limiter) prune(now time.Time) {
	for id, b := range l.buckets {
		b.refill(now)
		if b.tokens >= burst {
			delete(l.buckets, id)
		}
	}
}

// size is the bucket count, for the prune test.
func (l *Limiter) size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
