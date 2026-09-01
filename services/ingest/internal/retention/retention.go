// Package retention enforces per-tier retention on the D7 tables (D252): a
// fixed-cadence sweep that reads each workspace's plan from Postgres and
// deletes its rows past `plans.retention_days` from every swept table (`deletes`
// below). The table-level 90-day TTL (migrations 0004/0005) stays behind it
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
// The bound, stated rather than engineered around (D294): one workspace-table
// delete gets statementTimeout, and at the measured rate (~8.4s per million
// rows on the widest table) that is on the order of a hundred million
// past-cutoff rows in one workspace before a statement cannot finish. Past
// that the sweep does not chunk and does not fall back to a heavyweight
// mutation — it fails that statement loudly, counts it, moves to the next
// workspace, and retries the whole thing tomorrow. The consequence is bounded
// and benign: that workspace over-retains until the 90-day table TTL takes the
// rows, which is the direction D252 already called acceptable. Day-partition
// chunking on this same lightweight DELETE is the mechanism if it is ever
// needed (spans and logs are already PARTITION BY toDate); the trigger is
// sweep failures repeating for the same workspace across consecutive sweeps,
// which the log line below names by workspace and table.
//
// Retained semantic, stated once (D252): summaries expire on max_seen_date, so
// a trace straddling the cutoff loses its older spans while its summary
// survives to its own expiry — the same semantic the flat TTL had. The sweep
// deletes telemetry rows, never workspaces; D180's gate does not fire (D264d).
//
// D363 packet §4 (T5) extends the same mechanism, in place, to the three
// metrics objects that carry the 90-day outer TTL: metric_points_1m and
// metric_points_1h key on max_seen_date (the summaries' own semantic —
// AggregatingMergeTree, same as trace_summaries), and metric_series keys on
// last_seen so a workspace's catalog forgets series older than its plan's
// retention. Raw metric_points is DELIBERATELY NOT in this list: it is an
// implementation buffer (MV source + re-derivation), not a product promise,
// and carries its own flat 3-day table TTL — sweeping it would be redundant
// work enforcing a tier no contract states.
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
	//
	// It is sent to the server as well as held as a context deadline: the
	// deployed `obstack_ingest` profile caps queries at max_execution_time=60
	// (deploy/compose/clickhouse/users.d/obstack-users.xml and the chart's copy
	// of it), a cap sized for the hot path, and a cold-path sweep inheriting it
	// would abort — loudly and forever, with retention never enforced for that
	// workspace — the first time one workspace's backlog needs more than a
	// minute of masking. The profile sets a default, not a constraint, so the
	// sweep raises it for its own delete statements and nothing else.
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

// The deletes, one per swept table. Predicates match each table's own time
// column; the summaries cut on max_seen_date per the retained semantic above.
// Lightweight DELETE needs no system-table access — deliberate, because the
// ingest role has none (measured, CH6).
//
// spans and logs compare instants, which carry their own timezone; the
// summaries compare calendar dates, and max_seen_date is max(toDate(start_time))
// over a UTC column — so its cutoff is computed in UTC too rather than in
// whatever timezone the server happens to run in, which would move the cutoff a
// day in either direction, one of which is early deletion.
//
// metric_points_1m/_1h cut on max_seen_date for the same reason trace_summaries
// does (calendar date, no column timezone, so the cutoff is computed in UTC
// explicitly); metric_series cuts on last_seen, an instant column that carries
// its own UTC timezone like start_time/timestamp above. metric_points (raw) is
// intentionally absent from this list — packet §4: implementation buffer, flat
// 3-day table TTL only, never plan-swept.
var deletes = []struct {
	table string
	sql   string
}{
	{"spans", `DELETE FROM obstack.spans WHERE workspace_id = ? AND start_time < now() - toIntervalDay(?)`},
	{"logs", `DELETE FROM obstack.logs WHERE workspace_id = ? AND timestamp < now() - toIntervalDay(?)`},
	{"trace_summaries", `DELETE FROM obstack.trace_summaries WHERE workspace_id = ? AND max_seen_date < toDate(now('UTC') - toIntervalDay(?))`},
	{"metric_points_1m", `DELETE FROM obstack.metric_points_1m WHERE workspace_id = ? AND max_seen_date < toDate(now('UTC') - toIntervalDay(?))`},
	{"metric_points_1h", `DELETE FROM obstack.metric_points_1h WHERE workspace_id = ? AND max_seen_date < toDate(now('UTC') - toIntervalDay(?))`},
	{"metric_series", `DELETE FROM obstack.metric_series WHERE workspace_id = ? AND last_seen < now() - toIntervalDay(?)`},
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
		ctx = clickhouse.Context(ctx, clickhouse.WithSettings(clickhouse.Settings{
			"max_execution_time": int(statementTimeout / time.Second),
		}))
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

// Sweep runs one pass: resolve every workspace's tier, delete past it on every
// swept table (`deletes` above). A failed workspace or table is logged, counted
// and skipped — one workspace's failure must not starve the rest of theirs — and
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
			// Between statements, not only between workspaces: past a
			// cancelled context every remaining statement would fail on its
			// own deadline, counting failures and logging errors that are
			// shutdown, not retention.
			if ctx.Err() != nil {
				return
			}
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
