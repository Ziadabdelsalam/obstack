package metering

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// The accumulator's own rules are proven here with no database: what a failed
// flush costs, what the cap drops, and that recording never waits on a round
// trip — none of which an integration test can stage without breaking a real
// server. integration_test.go proves the half a fake cannot: that the UPSERT
// adds, including under two flushers at once.

// fakeClock stands in for time.Now, since hour buckets are not a thing a test
// can wait for.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

// fakeFlush is one flush transaction: what it was handed, how often, and whether
// it is currently failing.
type fakeFlush struct {
	batches []batch
	err     error
	// block, when set, holds the flush open until the test closes it — the way a
	// wedged Postgres holds a real one.
	block chan struct{}
}

func (f *fakeFlush) fn(_ context.Context, b batch) error {
	if f.block != nil {
		<-f.block
	}
	f.batches = append(f.batches, b)
	return f.err
}

func newTestMeter(t *testing.T) (*Meter, *fakeFlush, *fakeClock) {
	t.Helper()

	flush := &fakeFlush{}
	clock := &fakeClock{t: time.Date(2026, 8, 19, 12, 30, 0, 0, time.UTC)}

	m := newMeter(flush.fn)
	m.now = clock.now
	return m, flush, clock
}

func mustFlush(t *testing.T, m *Meter) {
	t.Helper()
	if err := m.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}
}

func lastBatch(t *testing.T, f *fakeFlush) batch {
	t.Helper()
	if len(f.batches) == 0 {
		t.Fatal("no flush happened")
	}
	return f.batches[len(f.batches)-1]
}

func hour(clock *fakeClock) time.Time { return clock.t.UTC().Truncate(time.Hour) }

// Accepted records meter per workspace and per hour for the ledger, and per key
// for health — the two granularities the two tables are about.
func TestAcceptedMetersPerWorkspaceHourAndPerKey(t *testing.T) {
	m, flush, clock := newTestMeter(t)

	firstHour := hour(clock)
	m.RecordAccepted("ws_alice", "key_a", 3, 2)
	m.RecordAccepted("ws_alice", "key_b", 1, 0)
	m.RecordAccepted("ws_bob", "key_c", 0, 7)

	clock.advance(time.Hour)
	secondHour := hour(clock)
	m.RecordAccepted("ws_alice", "key_a", 5, 0)

	mustFlush(t, m)
	b := lastBatch(t, flush)

	wantLedger := map[ledgerKey]ledgerCell{
		{workspaceID: "ws_alice", periodStart: firstHour}:  {spans: 4, logs: 2},
		{workspaceID: "ws_bob", periodStart: firstHour}:    {spans: 0, logs: 7},
		{workspaceID: "ws_alice", periodStart: secondHour}: {spans: 5},
	}
	if len(b.ledger) != len(wantLedger) {
		t.Fatalf("ledger has %d buckets, want %d: %+v", len(b.ledger), len(wantLedger), b.ledger)
	}
	for key, want := range wantLedger {
		if got := b.ledger[key]; got != want {
			t.Errorf("bucket %s/%s = %+v, want %+v", key.workspaceID, key.periodStart, got, want)
		}
	}

	// The key's accepted count is spans and logs together — liveness is about the
	// key, not the signal — and its last event is the latest one it carried.
	alice := b.health[healthKey{workspaceID: "ws_alice", keyID: "key_a"}]
	if alice.accepted != 10 {
		t.Errorf("key_a accepted = %d, want 10 (3+2 then 5)", alice.accepted)
	}
	if !alice.lastEventAt.Equal(clock.t) {
		t.Errorf("key_a last event = %s, want the latest accept at %s", alice.lastEventAt, clock.t)
	}
}

// Drops land in the column their reason names and never in the ledger: usage is
// what we accepted, so a drop is a health fact and never a billed one.
func TestDropsCountPerReasonAndNeverMeterUsage(t *testing.T) {
	m, flush, _ := newTestMeter(t)

	m.RecordDropped("ws_alice", "key_a", DropDecode, 2)
	m.RecordDropped("ws_alice", "key_a", DropUnsupported, 1)
	m.RecordDropped("ws_alice", "key_a", DropQuota, 40)
	m.RecordDropped("ws_alice", "key_a", DropQuota, 2)

	mustFlush(t, m)
	b := lastBatch(t, flush)

	if len(b.ledger) != 0 {
		t.Errorf("drops metered usage: %+v", b.ledger)
	}
	got := b.health[healthKey{workspaceID: "ws_alice", keyID: "key_a"}]
	want := healthCell{droppedDecode: 2, droppedUnsupported: 1, droppedQuota: 42}
	if got != want {
		t.Errorf("health cell = %+v, want %+v", got, want)
	}
	// A key that only ever dropped has no last event, and "never" must not reach
	// Postgres as the epoch.
	if !got.lastEventAt.IsZero() {
		t.Errorf("last event = %s, want zero for a key that carried nothing", got.lastEventAt)
	}
}

// Metric points meter into the key's health cell only — accepted and its last
// event, exactly as RecordAccepted's health half does — and never into the
// ledger: metrics carry no quota and RecordAccepted (the ledger writer) is
// D368-unusable for them (metering.go:244-270 writes usage_ledger, which has no
// column for metric points). The proof T3 owns: RecordAcceptedMetrics writes
// zero usage_ledger cells, so a quota decision reading the ledger can never see
// a metrics event.
func TestRecordAcceptedMetricsWritesZeroLedgerCells(t *testing.T) {
	m, flush, clock := newTestMeter(t)

	m.RecordAcceptedMetrics("ws_alice", "key_a", 7)
	m.RecordAcceptedMetrics("ws_alice", "key_a", 3)

	mustFlush(t, m)
	b := lastBatch(t, flush)

	if len(b.ledger) != 0 {
		t.Errorf("RecordAcceptedMetrics wrote %d ledger cells, want 0: %+v", len(b.ledger), b.ledger)
	}
	got := b.health[healthKey{workspaceID: "ws_alice", keyID: "key_a"}]
	if got.accepted != 10 {
		t.Errorf("health accepted = %d, want 10 (7+3)", got.accepted)
	}
	if !got.lastEventAt.Equal(clock.t) {
		t.Errorf("last event = %s, want the latest accept at %s", got.lastEventAt, clock.t)
	}
	// Nothing else in the cell moved — this is an accepted-and-liveness write only.
	if got.droppedDecode != 0 || got.droppedUnsupported != 0 || got.droppedQuota != 0 || got.droppedCardinality != 0 {
		t.Errorf("RecordAcceptedMetrics touched a drop column: %+v", got)
	}
}

// A count with no key or workspace has no committable home, the same rule
// RecordAccepted follows.
func TestRecordAcceptedMetricsSkipsKeylessCounts(t *testing.T) {
	m, flush, _ := newTestMeter(t)

	m.RecordAcceptedMetrics("ws_alice", "", 5)
	m.RecordAcceptedMetrics("", "key_a", 5)
	m.RecordAcceptedMetrics("ws_alice", "key_a", 0)

	// Every call above was skipped, so there is nothing to flush at all — the
	// same "nothing accumulated is nothing to write" rule TestEmptyFlushIsNoTransaction
	// proves.
	b := m.take()
	if !b.empty() {
		t.Errorf("a keyless or workspace-less metrics count was accumulated: %+v", b)
	}
	if err := m.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if len(flush.batches) != 0 {
		t.Errorf("an empty accumulator opened %d transactions", len(flush.batches))
	}
}

// The cardinality drop reason (packet §2, D368) lands in its own column, beside
// the other three, and never in the ledger.
func TestDropCardinalityCountsInItsOwnColumn(t *testing.T) {
	m, flush, _ := newTestMeter(t)

	m.RecordDropped("ws_alice", "key_a", DropCardinality, 12)
	m.RecordDropped("ws_alice", "key_a", DropQuota, 1)

	mustFlush(t, m)
	b := lastBatch(t, flush)

	if len(b.ledger) != 0 {
		t.Errorf("a drop metered usage: %+v", b.ledger)
	}
	got := b.health[healthKey{workspaceID: "ws_alice", keyID: "key_a"}]
	want := healthCell{droppedQuota: 1, droppedCardinality: 12}
	if got != want {
		t.Errorf("health cell = %+v, want %+v", got, want)
	}
}

// A failed flush costs nothing: the counts come back, add to whatever arrived
// during the attempt, and go out whole on the next tick. This is what makes the
// ledger's number right after a Postgres blip rather than merely eventually
// plausible.
func TestFailedFlushRetainsItsCountsAndRetriesTheSum(t *testing.T) {
	m, flush, clock := newTestMeter(t)
	bucket := hour(clock)

	m.RecordAccepted("ws_alice", "key_a", 10, 0)
	m.RecordDropped("ws_alice", "key_a", DropQuota, 3)

	flush.err = errors.New("postgres is down")
	if err := m.Flush(context.Background()); err == nil {
		t.Fatal("Flush returned nil for a failed transaction")
	}

	// The hot path kept going while it was down.
	m.RecordAccepted("ws_alice", "key_a", 0, 4)

	flush.err = nil
	mustFlush(t, m)
	b := lastBatch(t, flush)

	if got, want := b.ledger[ledgerKey{workspaceID: "ws_alice", periodStart: bucket}], (ledgerCell{spans: 10, logs: 4}); got != want {
		t.Errorf("bucket after the outage = %+v, want %+v — a retained count was lost", got, want)
	}
	if got := b.health[healthKey{workspaceID: "ws_alice", keyID: "key_a"}]; got.accepted != 14 || got.droppedQuota != 3 {
		t.Errorf("health cell after the outage = %+v, want accepted 14 and dropped_quota 3", got)
	}
}

// A flush that can never commit is discarded rather than retained: one row whose
// workspace was deleted would otherwise wedge every later flush behind a
// transaction that cannot succeed.
func TestUnretryableFlushIsDiscarded(t *testing.T) {
	m, flush, _ := newTestMeter(t)

	m.RecordAccepted("ws_gone", "key_gone", 5, 0)
	flush.err = &pgconn.PgError{Code: foreignKeyViolation, Message: "workspace_id violates foreign key constraint"}
	if err := m.Flush(context.Background()); err == nil {
		t.Fatal("Flush returned nil for a rejected transaction")
	}

	flush.err = nil
	if err := m.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if len(flush.batches) != 1 {
		t.Fatalf("%d flushes happened; the discarded counts were retried", len(flush.batches))
	}
}

// Recording never waits on Postgres. The counts are detached before the round
// trip, so a wedged database is a growing map and not a stalled export (PRD §9).
func TestRecordingDoesNotBlockOnAFlushInFlight(t *testing.T) {
	m, flush, clock := newTestMeter(t)
	bucket := hour(clock)

	m.RecordAccepted("ws_alice", "key_a", 1, 0)

	flush.block = make(chan struct{})
	flushed := make(chan error, 1)
	go func() { flushed <- m.Flush(context.Background()) }()

	// The maps are detached before the round trip, so an empty ledger is the
	// signal that the flush is now in flight — the state a real export lands in.
	deadline := time.Now().Add(5 * time.Second)
	for {
		m.mu.Lock()
		taken := len(m.ledger) == 0
		m.mu.Unlock()
		if taken {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the flush never detached the counts")
		}
		time.Sleep(time.Millisecond)
	}

	recorded := make(chan struct{})
	go func() {
		m.RecordAccepted("ws_alice", "key_a", 1, 0)
		close(recorded)
	}()

	select {
	case <-recorded:
	case <-time.After(5 * time.Second):
		t.Fatal("recording blocked behind a flush in flight")
	}

	close(flush.block)
	if err := <-flushed; err != nil {
		t.Fatalf("Flush: %v", err)
	}

	// What arrived during the flush is still there for the next one.
	mustFlush(t, m)
	if got := lastBatch(t, flush).ledger[ledgerKey{workspaceID: "ws_alice", periodStart: bucket}]; got.spans == 0 {
		t.Error("records taken during the flush were lost")
	}
}

// An idle process makes no round trips: nothing accumulated is nothing to write.
func TestEmptyFlushIsNoTransaction(t *testing.T) {
	m, flush, _ := newTestMeter(t)

	mustFlush(t, m)
	if len(flush.batches) != 0 {
		t.Errorf("an empty flush opened %d transactions", len(flush.batches))
	}
}

// The stated cost of a prolonged outage: past maxLedgerBuckets the oldest hours
// are dropped, so the retention is bounded and the freshest usage — the one the
// quota decision and the product surface are about to read — is the part kept.
func TestRetainedBucketsAreCappedOldestFirst(t *testing.T) {
	m, flush, clock := newTestMeter(t)

	flush.err = errors.New("postgres is down")
	oldest := hour(clock)
	for i := 0; i < maxLedgerBuckets+50; i++ {
		m.RecordAccepted("ws_alice", "key_a", 1, 0)
		clock.advance(time.Hour)
	}
	newest := hour(clock).Add(-time.Hour)

	if err := m.Flush(context.Background()); err == nil {
		t.Fatal("Flush returned nil for a failed transaction")
	}

	m.mu.Lock()
	kept := len(m.ledger)
	_, keptOldest := m.ledger[ledgerKey{workspaceID: "ws_alice", periodStart: oldest}]
	_, keptNewest := m.ledger[ledgerKey{workspaceID: "ws_alice", periodStart: newest}]
	m.mu.Unlock()

	if kept != maxLedgerBuckets {
		t.Errorf("retained %d buckets, want the cap of %d", kept, maxLedgerBuckets)
	}
	if keptOldest {
		t.Error("the oldest bucket survived the cap; the drop order is not oldest-first")
	}
	if !keptNewest {
		t.Error("the newest bucket was dropped; the freshest usage is the part that must be kept")
	}
}

// Rows go out in a fixed order so two flushers take Postgres row locks in the
// same order — map order would make a deadlock between our own transactions a
// matter of luck.
func TestFlushRowsAreOrderedDeterministically(t *testing.T) {
	m, _, clock := newTestMeter(t)

	first := hour(clock)
	m.RecordAccepted("ws_bob", "key_b", 1, 0)
	m.RecordAccepted("ws_alice", "key_a", 1, 0)
	clock.advance(time.Hour)
	second := hour(clock)
	m.RecordAccepted("ws_alice", "key_a", 1, 0)

	b := m.take()
	wantLedger := []ledgerKey{
		{workspaceID: "ws_alice", periodStart: first},
		{workspaceID: "ws_bob", periodStart: first},
		{workspaceID: "ws_alice", periodStart: second},
	}
	got := sortedLedgerKeys(b.ledger)
	for i, want := range wantLedger {
		if got[i] != want {
			t.Errorf("ledger row %d = %+v, want %+v", i, got[i], want)
		}
	}

	wantHealth := []healthKey{
		{workspaceID: "ws_alice", keyID: "key_a"},
		{workspaceID: "ws_bob", keyID: "key_b"},
	}
	gotHealth := sortedHealthKeys(b.health)
	for i, want := range wantHealth {
		if gotHealth[i] != want {
			t.Errorf("health row %d = %+v, want %+v", i, gotHealth[i], want)
		}
	}
}

// A count with no key has no committable home — api_key_health.key_id is a
// foreign key — so it is skipped rather than allowed to take a whole flush down.
// The workspace's usage still meters. A count with no workspace is skipped from
// the ledger for the same reason: usage_ledger.workspace_id is a foreign key
// too, and one uncommittable bucket would cost the snapshot every other
// workspace's usage.
func TestCountsWithoutAKeyDoNotEnterHealth(t *testing.T) {
	m, flush, clock := newTestMeter(t)

	m.RecordAccepted("ws_alice", "", 4, 0)
	m.RecordDropped("ws_alice", "", DropDecode, 2)
	m.RecordAccepted("", "", 9, 9)

	mustFlush(t, m)
	b := lastBatch(t, flush)

	if len(b.health) != 0 {
		t.Errorf("health carries keyless rows: %+v", b.health)
	}
	if got := b.ledger[ledgerKey{workspaceID: "ws_alice", periodStart: hour(clock)}]; got.spans != 4 {
		t.Errorf("workspace usage = %+v, want the 4 spans metered regardless of the key", got)
	}
	if len(b.ledger) != 1 {
		t.Errorf("the ledger carries a bucket with no workspace: %+v", b.ledger)
	}
}

// Run flushes on the interval and once more on shutdown, so a clean stop does not
// lose up to flushInterval of usage.
func TestRunFlushesOnShutdown(t *testing.T) {
	m, flush, _ := newTestMeter(t)
	m.RecordAccepted("ws_alice", "key_a", 2, 0)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		m.Run(ctx)
		close(done)
	}()

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}

	if len(flush.batches) != 1 {
		t.Fatalf("%d flushes happened, want the one on shutdown", len(flush.batches))
	}
}

// The windowed buckets (D260): the same events the cumulative cells count, in
// the minute they happened in — which is what makes a /min figure computable
// instead of estimated (D218's refusal answered).
func TestWindowsBucketByMinute(t *testing.T) {
	m, flush, clock := newTestMeter(t)

	m.RecordAccepted("ws", "key", 3, 2)
	clock.advance(90 * time.Second)
	m.RecordAccepted("ws", "key", 10, 0)
	m.RecordDropped("ws", "key", DropDecode, 1)
	mustFlush(t, m)

	b := lastBatch(t, flush)
	if len(b.windows) != 2 {
		t.Fatalf("flushed %d minute buckets, want 2", len(b.windows))
	}

	first := windowKey{workspaceID: "ws", keyID: "key", bucketStart: time.Date(2026, 8, 19, 12, 30, 0, 0, time.UTC)}
	second := windowKey{workspaceID: "ws", keyID: "key", bucketStart: time.Date(2026, 8, 19, 12, 31, 0, 0, time.UTC)}

	if got := b.windows[first].accepted; got != 5 {
		t.Errorf("first bucket accepted = %d, want 5", got)
	}
	if got := b.windows[second].accepted; got != 10 {
		t.Errorf("second bucket accepted = %d, want 10", got)
	}
	if got := b.windows[second].droppedDecode; got != 1 {
		t.Errorf("second bucket decode drops = %d, want 1", got)
	}

	// The cumulative cell counts exactly the same events, once.
	cell := b.health[healthKey{workspaceID: "ws", keyID: "key"}]
	if cell.accepted != 15 || cell.droppedDecode != 1 {
		t.Errorf("cumulative cell = %+v, want 15 accepted / 1 decode drop", cell)
	}
}

// A failed flush retains its buckets, but only the ones still inside the stated
// retention: a long outage must not accumulate buckets nothing will render.
func TestRetainedWindowsRespectRetention(t *testing.T) {
	m, flush, clock := newTestMeter(t)
	flush.err = errors.New("postgres away")

	m.RecordAccepted("ws", "key", 1, 0)
	if err := m.Flush(context.Background()); err == nil {
		t.Fatal("Flush succeeded, want the injected failure")
	}
	if len(m.windows) != 1 {
		t.Fatalf("retained %d buckets, want the failed flush's 1", len(m.windows))
	}

	// Past the retention the same bucket is no longer retained on a retry.
	m.windows = map[windowKey]healthCell{}
	m.RecordAccepted("ws", "key", 1, 0)
	clock.advance(windowRetention + time.Minute)
	if err := m.Flush(context.Background()); err == nil {
		t.Fatal("Flush succeeded, want the injected failure")
	}
	if len(m.windows) != 0 {
		t.Errorf("retained %d buckets past the retention, want 0", len(m.windows))
	}
}
