// Package retention enforces per-tier retention on the D7 tables (D252): a
// fixed-cadence sweep that reads each workspace's plan from Postgres and
// deletes its rows past `plans.retention_days` from spans, logs and
// trace_summaries. The table-level 90-day TTL (migration 0004) stays behind it
// as the outer bound, so a sweep that stops running degrades to over-delivery —
// the benign direction — never to unbounded growth.
//
// The mechanism is the one D252 ruled and the 2026-08-23 breakdown measured on
// the pinned clickhouse-server:26.3.17.110: lightweight DELETE, which works on
// all three engines including the AggregatingMergeTree summaries (0.08–8.4s per
// ~1M rows per statement), masks rows immediately (`_row_exists = 0`), and
// reclaims bytes at merge. "Deleted" therefore means gone from every product
// read the moment the statement returns; disk shrinks in the background — the
// operator docs state both halves (D292).
//
// Reading the CURRENT plan at sweep time is the point (D252's D13 ground): an
// upgrade extends retention of already-written rows and a downgrade shortens
// it, because the row's lifetime is a function of today's plan, not of the plan
// at write time. The plan read is a direct Postgres query on the cold path —
// the D98/D99 keystore cache is a hot-path artifact and is not coupled to this;
// a workspace with no workspace_plans row is on free (D163), in the SQL itself.
//
// Every replica runs the sweep (D286): deletes are idempotent by construction —
// two replicas masking the same rows converge on the same state — so there is
// no leader, no lease and no jitter, the same no-coordination posture the
// metering flusher established. At the replica counts the chart ships (1),
// the duplicate work is a few idempotent statements a day.
//
// Retained semantic, stated once (D252): summaries expire on max_seen_date, so
// a trace straddling the cutoff loses its older spans while its summary
// survives to its own expiry — the same semantic the flat TTL had. The sweep
// deletes telemetry rows, never workspaces; D180's gate does not fire (D264d).
package retention

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

const (
	// sweepInterval is the stated cadence (D252: daily grain — TTL granularity
	// is days, so sweeping more often than the unit of the promise buys
	// nothing).
	sweepInterval = 24 * time.Hour

	// startupDelay holds the first sweep back from boot so a crash-looping pod
	// is not a delete-looping pod, and boot-time work (migrations, cache warm)
	// is not contending with mutations.
	startupDelay = 2 * time.Minute

	// statementTimeout bounds one DELETE. The breakdown measured 8.4s per ~1M
	// rows on the widest table; this is generous headroom over that, and small
	// enough that a wedged mutation queue fails the statement loudly rather
	// than wedging the sweep for a day.
	statementTimeout = 15 * time.Minute

	// planQueryTimeout bounds the Postgres read that starts a sweep.
	planQueryTimeout = 30 * time.Second
)

// plansSQL resolves every workspace to its retention, absent row = free — the
// D163 rule in the query rather than in code, the same COALESCE shape the web
// tier's usage read documents at 0005_metering.sql.
const plansSQL = `
	SELECT w.id, p.retention_days
	  FROM workspaces w
	  LEFT JOIN workspace_plans wp ON wp.workspace_id = w.id
	  JOIN plans p ON p.id = COALESCE(wp.plan_id, 'free')
	 ORDER BY w.id`

// The three deletes. Predicates match each table's own time column; the
// summaries cut on max_seen_date per the retained semantic above. Lightweight
// DELETE needs no system-table access — deliberate, because the ingest role
// has none (measured, CH6).
var deletes = []struct {
	table string
	sql   string
}{
	{"spans", `DELETE FROM obstack.spans WHERE workspace_id = ? AND start_time < now() - toIntervalDay(?)`},
	{"logs", `DELETE FROM obstack.logs WHERE workspace_id = ? AND timestamp < now() - toIntervalDay(?)`},
	{"trace_summaries", `DELETE FROM obstack.trace_summaries WHERE workspace_id = ? AND max_seen_date < toDate(now() - toIntervalDay(?))`},
}

// Ops-only counters, the metering flusher's split: what a customer sees is the
// data's absence, these are for the operator watching the loop itself.
var (
	sweeps = promauto.NewCounter(prometheus.CounterOpts{
		Name: "obstack_ingest_retention_sweeps_total",
		Help: "Retention sweeps completed, including sweeps in which some statements failed.",
	})

	sweepFailures = promauto.NewCounter(prometheus.CounterOpts{
		Name: "obstack_ingest_retention_sweep_failures_total",
		Help: "Retention sweep statements or plan reads that failed; the sweep continues past a failed workspace and retries everything next interval.",
	})
)

// workspaceRetention is one workspace's resolved tier.
type workspaceRetention struct {
	workspaceID   string
	retentionDays int32
}

// Sweeper runs the retention loop against the two stores.
type Sweeper struct {
	// plans reads every workspace's retention; a field so the sweep's
	// continue-past-failure and fan-out semantics are testable with no
	// database to point at, the metering flushFunc pattern.
	plans func(ctx context.Context) ([]workspaceRetention, error)
	// del issues one table's delete for one workspace.
	del func(ctx context.Context, table, sql, workspaceID string, days int32) error

	close func() error
}

// Config describes one sweeper.
type Config struct {
	// DSN is the ClickHouse write DSN, the same one the writer holds; the
	// sweeper opens its own cold-path connection so mutation traffic never
	// shares the writer's insert path.
	DSN string
	// Pool is the process's one Postgres pool (D164e).
	Pool *pgxpool.Pool
}

// New connects and pings. A sweeper that cannot reach ClickHouse is a boot
// failure like the writer's: a process claiming to own retention must be able
// to enforce it.
func New(ctx context.Context, cfg Config) (*Sweeper, error) {
	opts, err := clickhouse.ParseDSN(cfg.DSN)
	if err != nil {
		return nil, fmt.Errorf("parse CLICKHOUSE_DSN: %w", err)
	}
	conn, err := clickhouse.Open(opts)
	if err != nil {
		return nil, fmt.Errorf("open clickhouse for retention: %w", err)
	}
	if err := conn.Ping(ctx); err != nil {
		conn.Close()
		return nil, fmt.Errorf("ping clickhouse for retention: %w", err)
	}

	s := &Sweeper{close: conn.Close}
	s.plans = func(ctx context.Context) ([]workspaceRetention, error) {
		ctx, cancel := context.WithTimeout(ctx, planQueryTimeout)
		defer cancel()
		rows, err := cfg.Pool.Query(ctx, plansSQL)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []workspaceRetention
		for rows.Next() {
			var w workspaceRetention
			if err := rows.Scan(&w.workspaceID, &w.retentionDays); err != nil {
				return nil, err
			}
			out = append(out, w)
		}
		return out, rows.Err()
	}
	s.del = func(ctx context.Context, table, sql, workspaceID string, days int32) error {
		ctx, cancel := context.WithTimeout(ctx, statementTimeout)
		defer cancel()
		return conn.Exec(ctx, sql, workspaceID, days)
	}
	return s, nil
}

// Close releases the sweeper's ClickHouse connection. The caller that stopped
// Run owns calling it, the writer's ownership shape.
func (s *Sweeper) Close() {
	if s.close != nil {
		s.close() //nolint:errcheck // shutting down; nothing to do with it
	}
}

// Run sweeps after the startup delay and then every sweepInterval until the
// context is cancelled. Unlike the meter there is no final pass on the way out:
// retention holds still while a process restarts, and an in-flight statement is
// abandoned with the context rather than holding shutdown hostage.
func (s *Sweeper) Run(ctx context.Context) {
	select {
	case <-time.After(startupDelay):
	case <-ctx.Done():
		return
	}
	s.Sweep(ctx)

	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			s.Sweep(ctx)
		case <-ctx.Done():
			return
		}
	}
}

// Sweep runs one pass: resolve every workspace's tier, delete past it on all
// three tables. A failed workspace or table is logged, counted and skipped —
// one workspace's failure must not starve the rest of their retention — and
// everything failed is naturally retried whole next interval, because a sweep
// carries no state between runs.
func (s *Sweeper) Sweep(ctx context.Context) {
	workspaces, err := s.plans(ctx)
	if err != nil {
		sweepFailures.Inc()
		slog.Error("retention sweep could not read workspace plans", "error", err)
		return
	}

	failed := 0
	for _, w := range workspaces {
		if ctx.Err() != nil {
			return
		}
		if w.retentionDays <= 0 {
			// A non-positive tier would delete everything a workspace has ever
			// sent. No catalog row says that; refuse it loudly rather than
			// trust it.
			sweepFailures.Inc()
			slog.Error("retention sweep refusing non-positive retention",
				"workspace", w.workspaceID, "retention_days", w.retentionDays)
			continue
		}
		for _, d := range deletes {
			if err := s.del(ctx, d.table, d.sql, w.workspaceID, w.retentionDays); err != nil {
				failed++
				sweepFailures.Inc()
				slog.Error("retention delete failed",
					"workspace", w.workspaceID, "table", d.table,
					"retention_days", w.retentionDays, "error", err)
			}
		}
	}

	sweeps.Inc()
	// Lightweight DELETE reports no row count, so the honest log is the cutoff
	// applied, not a number nothing measured.
	slog.Info("retention sweep completed",
		"workspaces", len(workspaces), "failed_statements", failed)
}
