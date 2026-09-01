// Package metering accumulates what ingest accepted and dropped — per workspace
// for the usage ledger, per API key for the health rows — and flushes it into
// Postgres on a fixed interval (D166). Those rows are the ledger of record
// (D99): the number the billing tab shows, the number the banner raises from,
// the number the quota decision reads and the number the reporter sends to Polar
// all come from here, so there is one count and nothing to reconcile. Prometheus
// counts the same events for operators and is never reconciled against this.
//
// Every write is an UPSERT that adds and never sets (D162), so N replicas
// flushing the same bucket concurrently is correct by construction rather than
// by coordination — there is no leader, no lease and no watermark. Rows are
// ordered within a flush so two flushers take Postgres row locks in the same
// order; without that, two transactions touching the same two buckets in map
// order would deadlock each other for no reason.
//
// The hot path never blocks on Postgres and never fails on it. Recording is a
// map write under a mutex held for nanoseconds; the flush swaps the maps out and
// does its round trip on the snapshot with the lock released, so a wedged
// database costs an export nothing. A failed flush keeps its counts and retries
// on the next tick, bounded by maxLedgerBuckets: past that cap the oldest hour
// buckets are dropped, logged and counted ops-side, because unbounded retention
// of an unwritable ledger would trade a billing undercount for the process.
// Health cells need no such cap — one per (workspace, key) pair that resolved a
// real api_keys row, so nothing an unauthenticated caller sends can grow them.
// A flush that dies on a foreign key discards the whole snapshot rather than the
// offending rows, which is accepted for M3 (D180): no surface deletes a workspace
// yet, so the case is unreachable, and the cost if it were reached is one flush
// interval of undercount in the customer's favour — the per-row retry that would
// save the rest is registered to the M4 inventory beside D119/D123/D153, gated on
// the first deletion surface that makes it reachable.
//
// Staleness, stated once: usage lands within flushInterval, and a quota crossing
// is therefore honored within flushInterval (5s) plus the keystore's TTL (30s).
package metering

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

const (
	// flushInterval is how long a count sits in memory before it is a row. Five
	// seconds is short enough that the product's "as of" is honest and the quota
	// decision is not fighting a stale ledger, and long enough that a busy
	// workspace is one UPSERT per bucket rather than one per export.
	flushInterval = 5 * time.Second

	// flushTimeout bounds one flush transaction. Without it a wedged Postgres
	// would hold the snapshot — and everything accumulated behind it — for as
	// long as the connection stayed open.
	flushTimeout = 10 * time.Second

	// maxLedgerBuckets is the stated cap on retained-but-unwritten hour buckets.
	// One workspace produces one bucket an hour, so this is a long outage across
	// many workspaces before anything is dropped; past it the oldest buckets go
	// first, since the freshest usage is the one the quota decision and the
	// product surface are about to read.
	maxLedgerBuckets = 10_000

	// windowRetention is how long a minute bucket stays readable (D260/D296).
	// Fifteen minutes is the five-minute window anything actually renders plus
	// ten of margin, which covers the flush lag, a recovering replica's
	// retained batch, and the clock skew between the process that stamps a
	// bucket and the Postgres `now()` the read window is computed from. It was
	// 65 for "an hour of history" that nothing renders — storage bought for a
	// reader that does not exist. Enforced in the same transaction as the
	// writes, which is what bounds this table with nothing scheduled.
	windowRetention = 15 * time.Minute
)

// The UPSERTs of record (D162). They add rather than set, which is the whole
// reason a replica does not have to know about any other replica, and they touch
// updated_at on every write because updated_at is the "as of" the product states.
const (
	ledgerUpsertSQL = `INSERT INTO usage_ledger (workspace_id, period_start, spans, logs)
VALUES ($1, $2, $3, $4)
ON CONFLICT (workspace_id, period_start) DO UPDATE
  SET spans = usage_ledger.spans + EXCLUDED.spans,
      logs = usage_ledger.logs + EXCLUDED.logs,
      updated_at = now()`

	// GREATEST ignores NULLs in Postgres, which is exactly the semantics wanted
	// here: a flush carrying only drops leaves an existing last_event_at alone,
	// and a key that has never carried an accepted record keeps NULL rather than
	// rendering as the epoch.
	healthUpsertSQL = `INSERT INTO api_key_health (key_id, workspace_id, accepted, dropped_decode, dropped_unsupported, dropped_quota, dropped_cardinality, last_event_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (key_id) DO UPDATE
  SET accepted = api_key_health.accepted + EXCLUDED.accepted,
      dropped_decode = api_key_health.dropped_decode + EXCLUDED.dropped_decode,
      dropped_unsupported = api_key_health.dropped_unsupported + EXCLUDED.dropped_unsupported,
      dropped_quota = api_key_health.dropped_quota + EXCLUDED.dropped_quota,
      dropped_cardinality = api_key_health.dropped_cardinality + EXCLUDED.dropped_cardinality,
      last_event_at = GREATEST(api_key_health.last_event_at, EXCLUDED.last_event_at),
      updated_at = now()`

	// The windowed counterpart (D260): the same add-never-set semantics on a
	// minute bucket, so the rate the product renders is computed from counts
	// rather than estimated from cumulative totals (D218's refusal answered).
	windowUpsertSQL = `INSERT INTO api_key_health_windows (key_id, workspace_id, bucket_start, accepted, dropped_decode, dropped_unsupported, dropped_quota, dropped_cardinality)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (key_id, bucket_start) DO UPDATE
  SET accepted = api_key_health_windows.accepted + EXCLUDED.accepted,
      dropped_decode = api_key_health_windows.dropped_decode + EXCLUDED.dropped_decode,
      dropped_unsupported = api_key_health_windows.dropped_unsupported + EXCLUDED.dropped_unsupported,
      dropped_quota = api_key_health_windows.dropped_quota + EXCLUDED.dropped_quota,
      dropped_cardinality = api_key_health_windows.dropped_cardinality + EXCLUDED.dropped_cardinality`

	// Retention, in the same transaction as the writes: the table's bound is a
	// property of the flush rather than of a job someone has to remember.
	windowTrimSQL = `DELETE FROM api_key_health_windows WHERE bucket_start < $1`
)

// Ops-only counters for the flusher itself. They live here rather than in
// internal/metrics because they are not pipeline drops: no `reason` vocabulary,
// no workspace label, nothing a customer surface reads. What a customer sees is
// the row in Postgres or its absence.
var (
	flushFailures = promauto.NewCounter(prometheus.CounterOpts{
		Name: "obstack_ingest_meter_flush_failures_total",
		Help: "Metering flush transactions that failed; their counts are retained and retried.",
	})

	droppedRows = promauto.NewCounter(prometheus.CounterOpts{
		Name: "obstack_ingest_meter_dropped_rows_total",
		Help: "Accumulated metering rows dropped without reaching Postgres, either past the retention cap during a prolonged outage or because the workspace or key they belong to no longer exists.",
	})
)

// DropReason names one of api_key_health's fixed drop columns (D162). The
// columns are fixed rather than a JSONB map because the UPSERT above cannot add
// safely over a document; a new reason is an ordinary migration.
type DropReason int

const (
	// DropDecode — an OTLP payload that could not be unmarshalled.
	DropDecode DropReason = iota
	// DropUnsupported — a Content-Type the OTLP/HTTP endpoint does not speak.
	DropUnsupported
	// DropQuota — records shed by head sampling because the workspace is over
	// its plan's quota (D165).
	DropQuota
	// DropCardinality — a metric point that would have created a NEW series
	// past the per-workspace 25k-active-series cap (packet §2). Established
	// series never drop under this reason.
	DropCardinality
)

// Meter accumulates counts in memory and writes them as the D162 UPSERT-adds.
type Meter struct {
	pool *pgxpool.Pool

	// flush is one flush transaction, a field rather than a direct call so the
	// retention and cap semantics — which decide what a Postgres outage costs
	// the ledger — are testable with no database to point at.
	flush flushFunc
	// now is the clock, likewise: hour buckets and last_event_at are not things
	// a test can wait for.
	now func() time.Time

	mu     sync.Mutex
	health map[healthKey]healthCell
	ledger map[ledgerKey]ledgerCell
	// lastTrimmed is the cutoff minute this process last swept window rows
	// past. The retention DELETE is idempotent, so running it every flush was
	// correct — just twelve identical scans a minute per replica for the
	// eleven-in-twelve that could delete nothing. Firing only when the cutoff
	// minute advances costs one in-memory comparison and needs no coordination
	// with any other replica (D296).
	lastTrimmed time.Time
	// windows carries the same per-key counts as health, split into the minute
	// buckets a true rate is computed from (D260). It accumulates beside health
	// rather than being derived from it, because a cumulative total cannot be
	// un-summed back into the minute it happened in.
	windows map[windowKey]healthCell
}

// flushFunc writes one snapshot. An error means none of it landed — the snapshot
// is one transaction — so the caller can retain it whole.
type flushFunc func(ctx context.Context, b batch) error

type healthKey struct{ workspaceID, keyID string }

// windowKey is a health cell in the minute it happened in.
type windowKey struct {
	workspaceID, keyID string
	bucketStart        time.Time
}

type ledgerKey struct {
	workspaceID string
	periodStart time.Time
}

type healthCell struct {
	accepted           int64
	droppedDecode      int64
	droppedUnsupported int64
	droppedQuota       int64
	droppedCardinality int64
	lastEventAt        time.Time
}

type ledgerCell struct{ spans, logs int64 }

// batch is one flush's worth of counts, detached from the live maps.
type batch struct {
	health  map[healthKey]healthCell
	ledger  map[ledgerKey]ledgerCell
	windows map[windowKey]healthCell
}

func (b batch) empty() bool {
	return len(b.health) == 0 && len(b.ledger) == 0 && len(b.windows) == 0
}

// New meters into the given pool. The pool is the process's one pool (D164e) —
// the keystore reads keys through it and this writes counts through it, so a
// metering flush and a key lookup contend for the same bounded set of
// connections rather than for two.
func New(pool *pgxpool.Pool) *Meter {
	m := newMeter(nil)
	m.pool = pool
	m.flush = m.flushPostgres
	return m
}

func newMeter(flush flushFunc) *Meter {
	return &Meter{
		flush:   flush,
		now:     time.Now,
		health:  map[healthKey]healthCell{},
		ledger:  map[ledgerKey]ledgerCell{},
		windows: map[windowKey]healthCell{},
	}
}

// RecordAccepted counts records this key carried into the pipeline: spans and
// logs separately into the workspace's hour bucket, because they are separately
// meaningful to an operator, and together into the key's accepted count and its
// last event, because liveness is about the key rather than the signal.
func (m *Meter) RecordAccepted(workspaceID, keyID string, spans, logs int64) {
	if spans <= 0 && logs <= 0 {
		return
	}
	at := m.now().UTC()

	m.mu.Lock()
	defer m.mu.Unlock()

	// A blank workspace id is skipped for the same reason a blank key id is:
	// usage_ledger.workspace_id is a foreign key, so such a bucket could never
	// commit, and one uncommittable row takes the whole snapshot — every other
	// workspace's usage in it — down with it.
	if workspaceID != "" {
		// The bucket boundary every replica lands on without agreeing on anything.
		key := ledgerKey{workspaceID: workspaceID, periodStart: at.Truncate(time.Hour)}
		cell := m.ledger[key]
		cell.spans += max(spans, 0)
		cell.logs += max(logs, 0)
		m.ledger[key] = cell
	}

	m.updateHealth(workspaceID, keyID, at, func(c *healthCell) {
		c.accepted += max(spans, 0) + max(logs, 0)
		c.lastEventAt = at
	})
}

// RecordAcceptedMetrics counts metric points a key carried into the pipeline,
// into the key's health cell only (D368): accepted and its last event, exactly
// as RecordAccepted's health half does. It never touches m.ledger — metrics
// carry no quota and are not billed usage, so usage_ledger has no column for
// them and none is added; RecordAccepted (metering.go, above) is unusable here
// for exactly that reason; a quota decision must never be able to fire on a
// metrics POST, and it cannot read what nothing writes.
func (m *Meter) RecordAcceptedMetrics(workspaceID, keyID string, points int64) {
	if points <= 0 {
		return
	}
	at := m.now().UTC()

	m.mu.Lock()
	defer m.mu.Unlock()

	m.updateHealth(workspaceID, keyID, at, func(c *healthCell) {
		c.accepted += points
		c.lastEventAt = at
	})
}

// RecordDropped counts records refused or shed after auth, under the column its
// reason names. Nothing here touches the ledger: usage is what we accepted, so a
// drop is a health fact and never a billed one.
func (m *Meter) RecordDropped(workspaceID, keyID string, reason DropReason, records int64) {
	if records <= 0 {
		return
	}
	at := m.now().UTC()

	m.mu.Lock()
	defer m.mu.Unlock()

	m.updateHealth(workspaceID, keyID, at, func(c *healthCell) {
		switch reason {
		case DropDecode:
			c.droppedDecode += records
		case DropUnsupported:
			c.droppedUnsupported += records
		case DropQuota:
			c.droppedQuota += records
		case DropCardinality:
			c.droppedCardinality += records
		}
	})
}

// updateHealth applies one change to a key's cell. Callers hold m.mu.
//
// A blank key id is skipped rather than accumulated: api_key_health.key_id is a
// foreign key, so such a row could never commit, and one uncommittable row would
// take a whole flush's counts down with it.
func (m *Meter) updateHealth(workspaceID, keyID string, at time.Time, apply func(*healthCell)) {
	if workspaceID == "" || keyID == "" {
		return
	}
	key := healthKey{workspaceID: workspaceID, keyID: keyID}
	cell := m.health[key]
	apply(&cell)
	m.health[key] = cell

	// The same change, in the minute it happened in (D260). One apply on two
	// accumulators rather than two call sites, so the windowed rate and the
	// cumulative total can never be counting different events.
	window := windowKey{workspaceID: workspaceID, keyID: keyID, bucketStart: at.Truncate(time.Minute)}
	bucket := m.windows[window]
	apply(&bucket)
	m.windows[window] = bucket
}

// Run flushes every flushInterval until the context is cancelled, then flushes
// once more so a clean shutdown does not lose up to five seconds of usage.
func (m *Meter) Run(ctx context.Context) {
	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if err := m.Flush(ctx); err != nil {
				slog.Warn("metering flush failed", "error", err)
			}
		case <-ctx.Done():
			// A fresh context: the one that stopped us is already cancelled, and
			// the final flush still has to be able to talk to Postgres.
			final, cancel := context.WithTimeout(context.Background(), flushTimeout)
			err := m.Flush(final)
			cancel()
			if err != nil {
				slog.Error("final metering flush failed", "error", err)
			}
			return
		}
	}
}

// Flush writes everything accumulated so far as one transaction. The counts are
// detached before the round trip, so recording never waits on it; a failure puts
// them back and the next tick retries the sum.
func (m *Meter) Flush(ctx context.Context) error {
	b := m.take()
	if b.empty() {
		return nil
	}

	err := m.flush(ctx, b)
	if err == nil {
		return nil
	}
	flushFailures.Inc()

	// A foreign key violation is not a transient failure: the workspace or the
	// key these counts belong to is gone, so no retry can ever commit them, and
	// retaining them would wedge every later flush behind a transaction that
	// cannot succeed. The snapshot is one transaction, so the discard costs the
	// counts of every workspace in it and not only the deleted one — one flush
	// interval of usage, once, against a permanently wedged ledger.
	if unretryable(err) {
		droppedRows.Add(float64(len(b.ledger) + len(b.health)))
		slog.Error("discarding metering counts whose workspace or key no longer exists",
			"buckets", len(b.ledger), "keys", len(b.health), "error", err)
		return err
	}

	m.retain(b)
	return err
}

// take detaches the accumulated counts, leaving empty maps behind for the
// records that arrive during the flush.
func (m *Meter) take() batch {
	m.mu.Lock()
	defer m.mu.Unlock()

	b := batch{health: m.health, ledger: m.ledger, windows: m.windows}
	m.health = map[healthKey]healthCell{}
	m.ledger = map[ledgerKey]ledgerCell{}
	m.windows = map[windowKey]healthCell{}
	return b
}

// retain merges a failed flush back in, adding to whatever arrived meanwhile, and
// enforces the cap.
func (m *Meter) retain(b batch) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for key, cell := range b.health {
		live := m.health[key]
		live.add(cell)
		m.health[key] = live
	}
	for key, cell := range b.ledger {
		live := m.ledger[key]
		live.spans += cell.spans
		live.logs += cell.logs
		m.ledger[key] = live
	}
	// Window buckets are retained on the same terms as the health cells they
	// mirror; the retention cutoff below is what keeps a long outage from
	// accumulating buckets nothing will ever render.
	cutoff := m.now().UTC().Add(-windowRetention)
	for key, cell := range b.windows {
		if key.bucketStart.Before(cutoff) {
			continue
		}
		live := m.windows[key]
		live.add(cell)
		m.windows[key] = live
	}
	m.trimLedger()
}

// trimLedger drops the oldest hour buckets past maxLedgerBuckets. Callers hold
// m.mu. This is the point where a prolonged outage becomes a stated undercount
// rather than an unbounded heap: loud in the logs, counted ops-side.
func (m *Meter) trimLedger() {
	if len(m.ledger) <= maxLedgerBuckets {
		return
	}

	keys := make([]ledgerKey, 0, len(m.ledger))
	for key := range m.ledger {
		keys = append(keys, key)
	}
	sortLedgerKeys(keys)

	drop := len(keys) - maxLedgerBuckets
	for _, key := range keys[:drop] {
		delete(m.ledger, key)
	}
	droppedRows.Add(float64(drop))
	slog.Error("dropping the oldest usage buckets: the ledger has been unwritable long enough to hit the retention cap",
		"dropped", drop, "cap", maxLedgerBuckets, "oldest_kept", keys[drop].periodStart)
}

func (c *healthCell) add(o healthCell) {
	c.accepted += o.accepted
	c.droppedDecode += o.droppedDecode
	c.droppedUnsupported += o.droppedUnsupported
	c.droppedQuota += o.droppedQuota
	c.droppedCardinality += o.droppedCardinality
	if o.lastEventAt.After(c.lastEventAt) {
		c.lastEventAt = o.lastEventAt
	}
}

// flushPostgres writes one snapshot as one transaction: either every count in it
// lands or none does, which is what lets a failure be retained whole.
func (m *Meter) flushPostgres(ctx context.Context, b batch) error {
	ctx, cancel := context.WithTimeout(ctx, flushTimeout)
	defer cancel()

	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin metering flush: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after a successful commit

	for _, key := range sortedLedgerKeys(b.ledger) {
		cell := b.ledger[key]
		if _, err := tx.Exec(ctx, ledgerUpsertSQL, key.workspaceID, key.periodStart, cell.spans, cell.logs); err != nil {
			return fmt.Errorf("usage ledger upsert: %w", err)
		}
	}
	for _, key := range sortedHealthKeys(b.health) {
		cell := b.health[key]
		var lastEventAt any
		if !cell.lastEventAt.IsZero() {
			lastEventAt = cell.lastEventAt
		}
		if _, err := tx.Exec(ctx, healthUpsertSQL, key.keyID, key.workspaceID,
			cell.accepted, cell.droppedDecode, cell.droppedUnsupported, cell.droppedQuota, cell.droppedCardinality, lastEventAt); err != nil {
			return fmt.Errorf("api key health upsert: %w", err)
		}
	}

	// The windowed rows go in the same transaction as their cumulative
	// counterparts (D260): one flush cannot land a rate the totals disagree
	// with, and the retention DELETE below rides the same commit, which is what
	// makes the table's bound a property of the flush rather than of a job.
	for _, key := range sortedWindowKeys(b.windows) {
		cell := b.windows[key]
		if _, err := tx.Exec(ctx, windowUpsertSQL, key.keyID, key.workspaceID, key.bucketStart,
			cell.accepted, cell.droppedDecode, cell.droppedUnsupported, cell.droppedQuota, cell.droppedCardinality); err != nil {
			return fmt.Errorf("api key health window upsert: %w", err)
		}
	}
	// Trim when this flush's cutoff minute is past the last one we swept — a
	// per-replica watermark, not a lease: two replicas trimming the same minute
	// delete the same rows and agree (D296).
	cutoff := m.now().UTC().Add(-windowRetention).Truncate(time.Minute)
	if cutoff.After(m.lastTrimmed) {
		if _, err := tx.Exec(ctx, windowTrimSQL, cutoff); err != nil {
			return fmt.Errorf("api key health window trim: %w", err)
		}
		m.lastTrimmed = cutoff
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit metering flush: %w", err)
	}
	return nil
}

// The rows of a flush go out in a fixed order so that two flushers — two
// replicas, or the ticker and a shutdown flush — take row locks in the same
// order. Map iteration order would make a deadlock between our own transactions
// a matter of luck, and a deadlocked flush is a retry that did not have to
// happen.
func sortedLedgerKeys(m map[ledgerKey]ledgerCell) []ledgerKey {
	keys := make([]ledgerKey, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sortLedgerKeys(keys)
	return keys
}

func sortLedgerKeys(keys []ledgerKey) {
	sort.Slice(keys, func(i, j int) bool {
		if !keys[i].periodStart.Equal(keys[j].periodStart) {
			return keys[i].periodStart.Before(keys[j].periodStart)
		}
		return keys[i].workspaceID < keys[j].workspaceID
	})
}

// Window rows take their locks in a fixed order for the reason the others do:
// two flushers touching the same buckets in map order would deadlock each other
// for no reason.
func sortedWindowKeys(m map[windowKey]healthCell) []windowKey {
	keys := make([]windowKey, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].keyID != keys[j].keyID {
			return keys[i].keyID < keys[j].keyID
		}
		return keys[i].bucketStart.Before(keys[j].bucketStart)
	})
	return keys
}

func sortedHealthKeys(m map[healthKey]healthCell) []healthKey {
	keys := make([]healthKey, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].keyID < keys[j].keyID })
	return keys
}

// unretryable reports whether a flush failed for a reason no retry can fix.
// 23503 is Postgres's foreign key violation: the workspace or the key the counts
// name is not there any more, so the counts have no home to land in.
func unretryable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == foreignKeyViolation
}

const foreignKeyViolation = "23503"
