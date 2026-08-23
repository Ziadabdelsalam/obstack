package write

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/mapping"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
)

// D263: close(ctx) threads the shutdown deadline into the final drain flush.
// A clean shutdown — the insert lands on its first try — must flush
// everything still buffered and return promptly, not wait out the deadline
// it never needed.
func TestBatcherCloseFlushesInsideDeadline(t *testing.T) {
	rec := &recorder{}
	b := newBatcher("spans", 1000, time.Hour,
		func(r mapping.SpanRow) string { return r.WorkspaceID }, rec.insert)

	// Under load: rows are still buffered when close() is called.
	b.enqueue(spanRows(5))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	start := time.Now()
	b.close(ctx)
	elapsed := time.Since(start)

	if elapsed > 200*time.Millisecond {
		t.Fatalf("close(ctx) took %v, want a fast clean flush well inside the 2s deadline", elapsed)
	}
	if got := len(rec.rows()); got != 5 {
		t.Fatalf("landed rows = %d, want 5 — a clean shutdown must not drop the last batch", got)
	}
}

var errFakeClickHouseDown = errors.New("clickhouse is down")

// D263: on a deadline overrun the retry loop stops short of its bounded
// attempts rather than sleep past ctx (uncoordinated, the ladder is ~90.75s
// per batcher), and the rows it could not land are counted dropped — loud
// and per-workspace, under the shutdown reason rather than the ordinary
// write-failure one, so the loss is never silent.
func TestBatcherCloseCountsOverrunDrops(t *testing.T) {
	counter := metrics.Dropped.WithLabelValues("ws_overrun", metrics.ReasonShutdown)
	writeCounter := metrics.Dropped.WithLabelValues("ws_overrun", metrics.ReasonWrite)
	before := testutil.ToFloat64(counter)
	beforeWrite := testutil.ToFloat64(writeCounter)

	rows := spanRows(3)
	for i := range rows {
		rows[i].WorkspaceID = "ws_overrun"
	}

	failing := func(context.Context, []mapping.SpanRow) error { return errFakeClickHouseDown }
	b := newBatcher("spans", 1000, time.Hour,
		func(r mapping.SpanRow) string { return r.WorkspaceID }, failing)

	b.enqueue(rows)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	start := time.Now()
	b.close(ctx)
	elapsed := time.Since(start)

	// maxAttempts*writeTimeout plus backoff is ~90.75s uncoordinated (the
	// corrected D263 fact); even the unbounded backoff alone (250ms+500ms)
	// would blow this bound, so a batcher honoring ctx has to stop during the
	// first backoff wait, close to the 100ms deadline, not sleep it out.
	if elapsed > 300*time.Millisecond {
		t.Fatalf("close(ctx) took %v, want it bounded by the 100ms ctx deadline, not the full retry ladder", elapsed)
	}
	if delta := testutil.ToFloat64(counter) - before; delta != 3 {
		t.Fatalf("shutdown drop delta = %v, want 3 — the deadline overrun must be counted, never silent", delta)
	}
	if delta := testutil.ToFloat64(writeCounter) - beforeWrite; delta != 0 {
		t.Fatalf("write drop delta = %v, want 0 — a deadline overrun is not an ordinary write failure", delta)
	}
}

// D263: a shutdown under load drains more than one batch — the channel holds
// queueBatches full batches behind the one being written — and every one of
// those drain flushes runs under close()'s deadline, not just the last partial
// one. A backlog is exactly the state a slow ClickHouse produces, so leaving
// the full ones on the ordinary unbounded path would put maxAttempts x
// writeTimeout per buffered batch inside Close and hand the process back to
// SIGKILL mid-flush — the loss D263 exists to stop.
func TestBatcherCloseBoundsEveryDrainBatch(t *testing.T) {
	counter := metrics.Dropped.WithLabelValues("ws_drain", metrics.ReasonShutdown)
	before := testutil.ToFloat64(counter)

	drainRows := func(n int) []mapping.SpanRow {
		rows := spanRows(n)
		for i := range rows {
			rows[i].WorkspaceID = "ws_drain"
		}
		return rows
	}

	inFlight := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	insert := func(context.Context, []mapping.SpanRow) error {
		if calls.Add(1) == 1 {
			close(inFlight)
			<-release
			return nil
		}
		return errFakeClickHouseDown
	}

	b := newBatcher("spans", 2, time.Hour,
		func(r mapping.SpanRow) string { return r.WorkspaceID }, insert)

	b.enqueue(drainRows(2)) // one full batch: run() is now inside insert
	<-inFlight
	b.enqueue(drainRows(6)) // three more full batches wait in the channel

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	closed := make(chan time.Duration, 1)
	go func() {
		start := time.Now()
		b.close(ctx)
		closed <- time.Since(start)
	}()
	// close() publishes the ctx before closing b.rows; give it that window,
	// then let the in-flight insert land so the drain runs under shutdown.
	time.Sleep(20 * time.Millisecond)
	close(release)

	elapsed := <-closed
	// On the ordinary unbounded path each of the three drain batches burns the
	// whole ladder (3 attempts plus 250ms+500ms of backoff): ~2.25s together.
	if elapsed > 500*time.Millisecond {
		t.Fatalf("close(ctx) took %v, want every drain batch bounded by the 100ms deadline, not one ladder each", elapsed)
	}
	if delta := testutil.ToFloat64(counter) - before; delta != 6 {
		t.Fatalf("shutdown drop delta = %v, want 6 — drain batches the deadline killed are counted too", delta)
	}
}

// D278: a retry ladder already running when close() lands — it started under
// the ordinary unbounded ctx because shutdown had not been published yet —
// must still gate on the deadline between attempts, the same as a ladder that
// starts after close(). Before this fix, send() captured its ctx once per
// call: a ladder already mid-retry never saw a deadline published under it,
// ran its full unbounded backoff-and-retry, and counted the drop under
// ReasonWrite as if ClickHouse alone had failed it — not ReasonShutdown, and
// not stopped short either.
func TestBatcherCloseAbandonsInFlightLadderPastDeadline(t *testing.T) {
	shutdownCounter := metrics.Dropped.WithLabelValues("ws_midladder", metrics.ReasonShutdown)
	writeCounter := metrics.Dropped.WithLabelValues("ws_midladder", metrics.ReasonWrite)
	beforeShutdown := testutil.ToFloat64(shutdownCounter)
	beforeWrite := testutil.ToFloat64(writeCounter)

	rows := spanRows(2)
	for i := range rows {
		rows[i].WorkspaceID = "ws_midladder"
	}

	attempt1Started := make(chan struct{})
	var calls atomic.Int32
	insert := func(context.Context, []mapping.SpanRow) error {
		if calls.Add(1) == 1 {
			close(attempt1Started)
		}
		return errFakeClickHouseDown
	}

	b := newBatcher("spans", 2, time.Hour,
		func(r mapping.SpanRow) string { return r.WorkspaceID }, insert)

	b.enqueue(rows) // one full batch: run() dispatches attempt 1 immediately
	<-attempt1Started

	// Attempt 1 has already failed and the ladder is now sleeping out its
	// 250ms backoff under the unbounded ctx it started with — the exact
	// window a ladder that never rechecked the deadline would sleep straight
	// through. Publish an already-expired deadline into it.
	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()

	start := time.Now()
	b.close(ctx)
	elapsed := time.Since(start)

	// A ladder honoring the live deadline stops after attempt 2 (the one that
	// finally sees it) plus the one 250ms backoff already in progress. The
	// buggy alternative runs the full ladder — attempt, 250ms, attempt, 500ms,
	// attempt — for ~750ms and misses the deadline entirely.
	if elapsed > 500*time.Millisecond {
		t.Fatalf("close(ctx) took %v, want the ladder to abandon its remaining retry once it saw the deadline, not run out its full unbounded backoff-and-retry", elapsed)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("insert calls = %d, want 2 — attempt 3 is the retry the live deadline must abandon", got)
	}
	if delta := testutil.ToFloat64(shutdownCounter) - beforeShutdown; delta != 2 {
		t.Fatalf("shutdown drop delta = %v, want 2 — a ladder that saw the deadline mid-retry must count its drop as a shutdown, not an ordinary write failure", delta)
	}
	if delta := testutil.ToFloat64(writeCounter) - beforeWrite; delta != 0 {
		t.Fatalf("write drop delta = %v, want 0 — the ladder never got its full unbounded say once the deadline landed", delta)
	}
}
