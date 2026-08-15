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
				// clean shutdown does not lose the last partial batch.
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
func (b *batcher[T]) send(rows []T) {
	if len(rows) == 0 {
		return
	}
	var err error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err = b.attempt(rows); err == nil {
			return
		}
		slog.Warn("clickhouse insert failed",
			"table", b.table, "rows", len(rows), "attempt", attempt, "error", err)
		if attempt < maxAttempts {
			time.Sleep(baseBackoff << (attempt - 1))
		}
	}
	slog.Error("dropping batch after failed inserts",
		"table", b.table, "rows", len(rows), "error", err)
	b.countDrops(rows)
}

func (b *batcher[T]) attempt(rows []T) error {
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return b.insert(ctx, rows)
}

func (b *batcher[T]) countDrops(rows []T) {
	perWorkspace := map[string]int{}
	for _, row := range rows {
		perWorkspace[b.workspaceOf(row)]++
	}
	for workspaceID, n := range perWorkspace {
		metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonWrite).Add(float64(n))
	}
}

// close stops accepting rows and waits for the final flush.
func (b *batcher[T]) close() {
	close(b.rows)
	<-b.stopped
}
