package write

import (
	"context"
	"log/slog"
	"time"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
)

// Flush bounds and retry policy (D5). Three attempts with a doubling backoff is
// enough to ride out a ClickHouse restart or a merge stall without letting a
// permanently broken table pile rows up in memory.
const (
	maxAttempts  = 3
	baseBackoff  = 250 * time.Millisecond
	writeTimeout = 30 * time.Second
)

// batcher accumulates rows for one table and writes them in native batches. One
// goroutine owns the buffer, so the OTLP handlers never touch it: enqueue is a
// channel send, which is what makes the D23 ACK-on-enqueue honest — the response
// goes out as soon as the rows are the writer's problem, not the client's.
type batcher[T any] struct {
	table       string
	rows        chan T
	maxRows     int
	interval    time.Duration
	workspaceOf func(T) string
	insert      func(context.Context, []T) error

	stopped chan struct{}

	// shutdown is closed by close() before b.rows is, publishing shutdownCtx
	// to run(): closing a channel happens-before a receive that observes the
	// close (Go memory model), so the one writer and one reader need no lock.
	// Every flush run() starts from then on is bounded by that ctx (D263) —
	// the full batches a backlog drains through as much as the last partial
	// one; see sendCtx.
	shutdown    chan struct{}
	shutdownCtx context.Context
}

func newBatcher[T any](table string, maxRows int, interval time.Duration, workspaceOf func(T) string, insert func(context.Context, []T) error) *batcher[T] {
	b := &batcher[T]{
		table: table,
		// Room for several full batches so a flush in progress does not stall
		// the receivers; past that, shedding beats unbounded memory growth.
		rows:        make(chan T, maxRows*queueBatches),
		maxRows:     maxRows,
		interval:    interval,
		workspaceOf: workspaceOf,
		insert:      insert,
		stopped:     make(chan struct{}),
		shutdown:    make(chan struct{}),
	}
	go b.run()
	return b
}

// queueBatches is how many full batches may sit in the channel behind the one
// being written.
const queueBatches = 4

// enqueue hands rows to the writer. It never blocks and never fails: a full
// queue means ClickHouse is not keeping up, and the rows are shed and counted
// under reason "overload" — our own backlog, told apart from the "write" drops
// of an INSERT ClickHouse actually refused, because the two ask for different
// fixes (D26).
func (b *batcher[T]) enqueue(rows []T) {
	for _, row := range rows {
		select {
		case b.rows <- row:
		default:
			metrics.Dropped.WithLabelValues(b.workspaceOf(row), metrics.ReasonOverload).Inc()
		}
	}
}

// run buffers until the batch is full or the interval elapses, whichever comes
// first (D5).
func (b *batcher[T]) run() {
	defer close(b.stopped)

	ticker := time.NewTicker(b.interval)
	defer ticker.Stop()

	buf := make([]T, 0, b.maxRows)
	for {
		select {
		case row, ok := <-b.rows:
			if !ok {
				// The channel is closed and drained: flush what is left so a
				// clean shutdown does not lose the last partial batch, and an
				// overrun one counts rather than runs the full retry ladder
				// past the caller's deadline (D263).
				b.send(buf)
				return
			}
			buf = append(buf, row)
			if len(buf) >= b.maxRows {
				b.send(buf)
				buf = buf[:0]
				// A batch just went out; the next one gets a full interval.
				ticker.Reset(b.interval)
			}
		case <-ticker.C:
			if len(buf) > 0 {
				b.send(buf)
				buf = buf[:0]
			}
		}
	}
}

// send writes one batch, retrying a failure a bounded number of times before
// dropping it (D5). A drop is loud in the logs and counted per workspace; it is
// never reported back to the exporter (D23).
//
// The shutdown deadline is live, not a snapshot (D278): every attempt asks
// sendCtx again rather than a ctx captured once at the top, so a ladder that
// was already running when close() lands — started under the ordinary
// unbounded ctx because shutdown had not been published yet — still gates on
// the deadline between attempts, the same as a ladder that started after it.
// What it cannot do is reach into an attempt already in flight: that one
// call to insert keeps running on its own writeTimeout bound (aborting a
// live INSERT mid-flight is refused — see close). Rows still unwritten once
// the live ctx is done are counted dropped under ReasonShutdown rather than
// ReasonWrite — that is this batcher running out of time, not ClickHouse
// refusing the insert after every attempt got its full say.
func (b *batcher[T]) send(rows []T) {
	if len(rows) == 0 {
		return
	}
	var err error
	var ctx context.Context
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		ctx = b.sendCtx()
		if err = b.attempt(ctx, rows); err == nil {
			return
		}
		slog.Warn("clickhouse insert failed",
			"table", b.table, "rows", len(rows), "attempt", attempt, "error", err)
		if attempt == maxAttempts || ctx.Err() != nil {
			break
		}
		if !sleepUnlessDone(ctx, baseBackoff<<(attempt-1)) {
			break // ctx ended during backoff — do not sleep the rest of it out
		}
	}
	if ctx.Err() != nil {
		slog.Error("dropping batch: shutdown deadline reached before it landed",
			"table", b.table, "rows", len(rows), "error", err)
		b.countDrops(rows, metrics.ReasonShutdown)
		return
	}
	slog.Error("dropping batch after failed inserts",
		"table", b.table, "rows", len(rows), "error", err)
	b.countDrops(rows, metrics.ReasonWrite)
}

// sendCtx bounds the flushes run() starts: the shutdown deadline once close()
// has published one — the drain can carry several full batches, and a backlog
// is exactly the state a slow ClickHouse leaves behind, so all of them are on
// the deadline — and an unbounded context the rest of the time, where the D5
// per-attempt writeTimeout is the only clock that should apply.
func (b *batcher[T]) sendCtx() context.Context {
	select {
	case <-b.shutdown:
		return b.shutdownCtx
	default:
		return context.Background()
	}
}

// sleepUnlessDone waits out one backoff, or stops early if ctx ends first.
// It is the mechanism that keeps send's retry loop from ever sleeping past a
// shutdown deadline (D263).
func sleepUnlessDone(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// attempt bounds one INSERT to whichever is tighter: the D5 write timeout, or
// what is left on ctx — context.WithTimeout derives its deadline from both,
// so a ctx with no deadline (the ordinary-flush case) leaves writeTimeout as
// the only bound.
func (b *batcher[T]) attempt(ctx context.Context, rows []T) error {
	attemptCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return b.insert(attemptCtx, rows)
}

func (b *batcher[T]) countDrops(rows []T, reason string) {
	perWorkspace := map[string]int{}
	for _, row := range rows {
		perWorkspace[b.workspaceOf(row)]++
	}
	for workspaceID, n := range perWorkspace {
		metrics.Dropped.WithLabelValues(workspaceID, reason).Add(float64(n))
	}
}

// beginClose publishes ctx as the shutdown deadline and stops accepting rows,
// without waiting for the drain. Split out of close so Writer.Close can
// publish to BOTH batchers before waiting on either (write.go): a batcher
// still on the ordinary unbounded path while its sibling drains would keep
// starting fresh ladders — and could open a fresh writeTimeout-long attempt
// right up to the moment its own close landed — which puts the pair's real
// worst case at two writeTimeouts, past the 45s grace both the chart and
// compose are sized on, rather than the one writeTimeout close states below.
func (b *batcher[T]) beginClose(ctx context.Context) {
	b.shutdownCtx = ctx
	close(b.shutdown)
	close(b.rows)
}

// close stops accepting rows and waits for the drain. It is best-effort-
// bounded, not hard-bounded (D278): ctx's deadline governs every attempt and
// every backoff from the moment it is published — see sendCtx and send — so
// a ladder already running when close lands gates on it too, not just the
// flushes that start after. What ctx cannot do is reach back into an INSERT
// already in flight: aborting one mid-attempt is refused for now, because
// what a cancelled INSERT leaves behind in a MergeTree — partial application,
// a retry landing as a duplicate — is an unmeasured question (S2.4 L1), not
// one this package answers by guessing. So the stated worst case is the
// deadline plus one writeTimeout: ctx's deadline for everything queued behind
// it, plus however much longer the one attempt already in flight when close
// was called takes to return on its own (today: 10s + 30s = 40s).
func (b *batcher[T]) close(ctx context.Context) {
	b.beginClose(ctx)
	<-b.stopped
}
