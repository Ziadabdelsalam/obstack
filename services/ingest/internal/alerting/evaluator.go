package alerting

// evaluator.go — the D477 evaluator: a ticker loop in the ingest binary (the
// retention sweep / metering flush house pattern), claiming due rules from
// Postgres, evaluating them against ClickHouse, and writing the D484 state
// machine's transitions as `pending` event rows.
//
// Three properties this file exists to hold, each stated where it is enforced:
//
//   - N replicas never double-evaluate a rule (D478). Not by a leader, a lease
//     or a watermark, but by `FOR UPDATE SKIP LOCKED` inside the same
//     transaction that writes the result: a rule another replica is holding is
//     simply not in this replica's claimed set.
//
//   - An event is produced by a TRANSITION, never by a state (D484). A rule
//     that is firing and still crossing its threshold emits nothing — the
//     alert already went out, and re-sending it every minute is how a pager
//     gets muted.
//
//   - An evaluation that could not be completed changes nothing (D480). A
//     ClickHouse outage, a statement timeout or a condition this binary cannot
//     parse leaves the rule's state exactly as it was, advances next_eval_at so
//     the loop does not spin on it, and counts it for the operator. Inventing a
//     severity out of an outage would point a customer's pager at our own
//     failure — a D13 violation with the worst possible blast radius.

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

const (
	// EvalInterval is D479: ONE cadence, 60 seconds, for every workspace and
	// every rule. Rules do not choose it and plans do not scale it — per-tier
	// cadence is a pricing decision, pre-registered as USER-VISIBLE for a
	// billing revisit rather than smuggled in as a constant here.
	EvalInterval = 60 * time.Second

	// claimBatch caps one tick's claimed set. It bounds a tick rather than the
	// product: claiming is ORDERED by next_eval_at, so the longest-overdue
	// rules go first and a workspace past the cap waits one cadence instead of
	// starving. The pathological tick — every evaluation timing out — is
	// claimBatch × evalTimeout long; the loop is one goroutine, so a slow tick
	// delays the next rather than overlapping it (time.Ticker drops the ones
	// it cannot deliver).
	claimBatch = 100

	// evalTimeout is the per-eval statement timeout D480 names. Small on
	// purpose: an alert evaluation reads one merged window and a read that
	// cannot finish in ten seconds is an outage, not a slow query worth
	// waiting on.
	evalTimeout = 10 * time.Second

	// The D484 state vocabulary, matching the DDL's CHECK.
	stateOK     = "ok"
	stateFiring = "firing"

	// severityInfo is what a resolution event carries regardless of how loud
	// the rule is (D484): recovery is never critical.
	severityInfo = "info"
)

// Ops-only counters (the retention/metering split): these are for the operator
// watching the loop. What a customer sees is their rule's state and their event
// feed, and the two are never reconciled against each other.
var (
	evalsFailed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "obstack_ingest_alert_evals_failed_total",
		Help: "Rule evaluations that could not be completed — an unreachable or slow ClickHouse, or a condition this binary cannot parse. The rule's state is left unchanged (D480).",
	})

	// D13, as a counter: an empty window is NOT a measured zero, so it gets its
	// own name rather than being folded into failures (nothing is broken) or
	// into successful evaluations (nothing was measured).
	evalsNoData = promauto.NewCounter(prometheus.CounterOpts{
		Name: "obstack_ingest_alert_evals_nodata_total",
		Help: "Rule evaluations whose window held no data at all; no transition is taken and no event is emitted.",
	})
)

// observation is one completed evaluation: the value the window actually held,
// the unit it is denominated in (for rendering only), and whether the window
// held anything at all.
//
// hasData is not a nicety. Every caller must branch on it before reading value,
// because a `false` observation carries a zero that means "nothing was
// measured" — the exact number a threshold like `< 1` would fire on.
type observation struct {
	value   float64
	unit    string
	hasData bool
}

// Config describes one evaluator.
type Config struct {
	// DSN is the ClickHouse DSN. The evaluator opens its own cold-path
	// connection, the sweeper's posture: alert reads must never share the
	// writer's insert path.
	DSN string
	// Pool is the process's one Postgres pool (D164e).
	Pool *pgxpool.Pool
}

// Evaluator runs the claim-and-evaluate loop against the two stores.
type Evaluator struct {
	pool *pgxpool.Pool

	// eval is the ClickHouse half, a field for the reason retention's `plans`
	// and `del` are fields: the state machine's proof is about transactions and
	// transitions, and must not need a telemetry store to run. The real
	// implementation is in eval_metric.go / eval_trace.go.
	eval func(ctx context.Context, workspaceID string, c Condition) (observation, error)

	conn  driver.Conn
	close func() error
}

// New connects and pings. An evaluator that cannot reach ClickHouse is a boot
// failure like the writer's and the sweeper's: a process claiming to own alert
// evaluation must be able to evaluate.
func New(ctx context.Context, cfg Config) (*Evaluator, error) {
	opts, err := clickhouse.ParseDSN(cfg.DSN)
	if err != nil {
		return nil, fmt.Errorf("parse CLICKHOUSE_DSN: %w", err)
	}
	conn, err := clickhouse.Open(opts)
	if err != nil {
		return nil, fmt.Errorf("open clickhouse for alerting: %w", err)
	}
	if err := conn.Ping(ctx); err != nil {
		conn.Close()
		return nil, fmt.Errorf("ping clickhouse for alerting: %w", err)
	}

	e := &Evaluator{pool: cfg.Pool, conn: conn, close: conn.Close}
	e.eval = e.evaluateCondition
	return e, nil
}

// Close releases the evaluator's ClickHouse connection. The caller that stopped
// Run owns calling it, the sweeper's ownership shape.
func (e *Evaluator) Close() {
	if e.close != nil {
		e.close() //nolint:errcheck // shutting down; nothing to do with it
	}
}

// Run evaluates once immediately and then every EvalInterval until the context
// is cancelled.
//
// The immediate pass is deliberate: a restart would otherwise be a full cadence
// of blindness, and the claim makes a boot-time thundering herd of replicas a
// non-event — whoever gets the row lock does the work and the rest see an empty
// claim. There is no final pass on the way out (the retention posture): an
// in-flight tick is abandoned with its context, rolls back whole, and is
// re-claimed by the next process or replica.
func (e *Evaluator) Run(ctx context.Context) {
	e.evaluateOnce(ctx)

	ticker := time.NewTicker(EvalInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			e.evaluateOnce(ctx)
		case <-ctx.Done():
			return
		}
	}
}

func (e *Evaluator) evaluateOnce(ctx context.Context) {
	if err := e.EvaluateDue(ctx); err != nil && ctx.Err() == nil {
		slog.Error("alert evaluation tick failed", "error", err)
	}
}

// claimSQL is D478's whole replica-correctness mechanism.
//
// It is DELIBERATELY workspace-blind, and that is not an oversight to fix: this
// query schedules, it does not read telemetry. Every read of a customer's data
// is workspace_id-first (D7/D11) in eval_metric.go and eval_trace.go, against
// the workspace_id carried on the row this claim returns. A `WHERE
// workspace_id = …` here would mean one loop per workspace and would not make
// a single customer's data one inch safer.
//
// ORDER BY next_eval_at with SKIP LOCKED means the longest-overdue rules are
// claimed first, so the claimBatch cap delays rather than starves. The partial
// index `(next_eval_at) WHERE enabled` (migration 0010) is this exact shape.
const claimSQL = `
	SELECT id, workspace_id, name, severity, channel_id, state, condition
	  FROM alert_rules
	 WHERE enabled AND next_eval_at <= now()
	 ORDER BY next_eval_at
	 LIMIT $1
	   FOR UPDATE SKIP LOCKED`

// insertEventSQL writes one transition as a pending event.
//
// channel_id is captured HERE, at emit time (D491): the event carries the
// channel the rule pointed at when it fired, so a later rule edit never
// retargets an alert that already happened.
//
// link is NULL in v1 and explicitly so. The alert window vocabulary (D482:
// 5m/15m/30m/1h) has no counterpart in /app/explore's `range` param
// (1h/6h/24h), and this process holds no configured public base URL to build an
// absolute link from — so a deep link would be a guess at both the origin and
// the time range. An honest absence beats a URL that lands somewhere else.
const insertEventSQL = `
	INSERT INTO alert_events (id, workspace_id, rule_id, channel_id, severity, title, detail, link)
	VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`

// The three rule writes. Every one of them advances next_eval_at — a claimed
// rule is always rescheduled, whatever the evaluation said — and none of them
// touches updated_at, which means "when the author last changed this rule" and
// would stop meaning anything if the loop bumped it sixty times an hour.
const (
	fireSQL = `
		UPDATE alert_rules
		   SET state = 'firing', last_triggered_at = now(),
		       next_eval_at = now() + make_interval(secs => $2::double precision)
		 WHERE id = $1`

	resolveSQL = `
		UPDATE alert_rules
		   SET state = 'ok',
		       next_eval_at = now() + make_interval(secs => $2::double precision)
		 WHERE id = $1`

	rescheduleSQL = `
		UPDATE alert_rules
		   SET next_eval_at = now() + make_interval(secs => $2::double precision)
		 WHERE id = $1`
)

// claimedRule is one row of the claimed set.
type claimedRule struct {
	id          string
	workspaceID string
	name        string
	severity    string
	channelID   string
	state       string
	condition   []byte
}

// EvaluateDue runs one tick: claim, evaluate, write, commit — all of it in ONE
// transaction, which is what makes the claim a claim. The row locks are held
// until the transitions they justify are durable, so a crash anywhere in here
// leaves the rules exactly as they were and the next tick redoes the work.
//
// Exported because D477 says the drive and the Go tests exercise the tick
// directly rather than waiting a minute for a ticker.
func (e *Evaluator) EvaluateDue(ctx context.Context) error {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin alert evaluation: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // a rollback after commit is a no-op

	claimed, err := claim(ctx, tx)
	if err != nil {
		return err
	}
	for _, r := range claimed {
		if err := e.evaluateRule(ctx, tx, r); err != nil {
			// A Postgres failure aborts the whole transaction anyway, so there
			// is nothing to salvage by continuing: roll back, count nothing,
			// and let the next tick re-claim the same set. Per-rule evaluation
			// failures never reach here — they are the D480 path below.
			return err
		}
	}
	return tx.Commit(ctx)
}

func claim(ctx context.Context, tx pgx.Tx) ([]claimedRule, error) {
	rows, err := tx.Query(ctx, claimSQL, claimBatch)
	if err != nil {
		return nil, fmt.Errorf("claim due alert rules: %w", err)
	}
	defer rows.Close()

	var claimed []claimedRule
	for rows.Next() {
		var r claimedRule
		if err := rows.Scan(&r.id, &r.workspaceID, &r.name, &r.severity,
			&r.channelID, &r.state, &r.condition); err != nil {
			return nil, fmt.Errorf("scan claimed alert rule: %w", err)
		}
		claimed = append(claimed, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("claim due alert rules: %w", err)
	}
	return claimed, nil
}

// evaluateRule is the D484 state machine for one claimed rule. Its error return
// is reserved for POSTGRES failures; every way an evaluation itself can fail
// ends in the fail-open path, which is a successful tick that changed nothing.
func (e *Evaluator) evaluateRule(ctx context.Context, tx pgx.Tx, r claimedRule) error {
	// Re-validated on claim, because a row in Postgres can predate any schema
	// change and the web tier's write-time validation cannot reach backwards.
	// A rejection is an eval FAILURE, never a panic and never a firing rule.
	cond, err := ParseCondition(r.condition)
	if err != nil {
		evalsFailed.Inc()
		slog.Warn("alert rule condition is not evaluable",
			"workspace", r.workspaceID, "rule", r.id, "error", err)
		return e.reschedule(ctx, tx, r.id)
	}

	obs, err := e.eval(ctx, r.workspaceID, cond)
	if err != nil {
		evalsFailed.Inc()
		slog.Warn("alert rule evaluation failed",
			"workspace", r.workspaceID, "rule", r.id, "source", cond.Source, "error", err)
		return e.reschedule(ctx, tx, r.id)
	}

	// D13, and the single most dangerous line in this package if it were
	// missing: an empty window is not a measured zero. A rule watching for an
	// error rate BELOW a threshold would fire on every silent minute — and
	// "your service is healthy" is exactly the alert nobody can act on.
	if !obs.hasData {
		evalsNoData.Inc()
		return e.reschedule(ctx, tx, r.id)
	}

	switch crossing := crossed(cond.Op, obs.value, cond.Threshold); {
	case crossing && r.state == stateOK:
		title, detail := firingText(r.name, cond, obs)
		// The RULE's severity, not a per-event guess (D484): the author of the
		// rule decided how loud this is.
		if err := insertEvent(ctx, tx, r, r.severity, title, detail); err != nil {
			return err
		}
		return exec(ctx, tx, fireSQL, r.id)

	case !crossing && r.state == stateFiring:
		title, detail := resolutionText(r.name, cond, obs)
		if err := insertEvent(ctx, tx, r, severityInfo, title, detail); err != nil {
			return err
		}
		return exec(ctx, tx, resolveSQL, r.id)

	default:
		// Still firing, or still fine. Either way nothing happened, and an
		// event per tick would be the alerting equivalent of a stuck horn.
		return e.reschedule(ctx, tx, r.id)
	}
}

func (e *Evaluator) reschedule(ctx context.Context, tx pgx.Tx, ruleID string) error {
	return exec(ctx, tx, rescheduleSQL, ruleID)
}

func exec(ctx context.Context, tx pgx.Tx, sql, ruleID string) error {
	if _, err := tx.Exec(ctx, sql, ruleID, EvalInterval.Seconds()); err != nil {
		return fmt.Errorf("update alert rule %s: %w", ruleID, err)
	}
	return nil
}

func insertEvent(ctx context.Context, tx pgx.Tx, r claimedRule, severity, title, detail string) error {
	if _, err := tx.Exec(ctx, insertEventSQL,
		newEventID(), r.workspaceID, r.id, r.channelID, severity, title, detail); err != nil {
		return fmt.Errorf("insert alert event for rule %s: %w", r.id, err)
	}
	return nil
}

// crossed compares the observed value with the threshold under the condition's
// operator. Strict on both sides: a value exactly ON the threshold has not
// crossed it, which keeps a rule sitting at its boundary from flapping once a
// minute forever.
func crossed(op string, observed, threshold float64) bool {
	if op == "<" {
		return observed < threshold
	}
	return observed > threshold
}

// evaluateCondition dispatches to the leg the condition names. Both legs are
// workspace_id-first; neither ever sees a workspace other than the one on the
// claimed row.
func (e *Evaluator) evaluateCondition(ctx context.Context, workspaceID string, c Condition) (observation, error) {
	ctx, cancel := context.WithTimeout(ctx, evalTimeout)
	defer cancel()
	// The timeout is sent to the server as well as held as a deadline, the
	// retention posture: the deployed obstack_ingest profile sets its own
	// max_execution_time default, and an alert read should live under the
	// bound this package states rather than one sized for the hot path.
	ctx = clickhouse.Context(ctx, clickhouse.WithSettings(clickhouse.Settings{
		"max_execution_time": int(evalTimeout / time.Second),
	}))

	switch c.Source {
	case SourceMetric:
		return e.evalMetric(ctx, workspaceID, c)
	case SourceTrace:
		return e.evalTrace(ctx, workspaceID, c)
	default:
		// Unreachable: ParseCondition admits exactly two sources. An error
		// rather than a panic keeps the D480 posture even here.
		return observation{}, fmt.Errorf("%w: unknown source %q", ErrInvalidCondition, c.Source)
	}
}

// windowSeconds turns the D482 vocabulary into the number both legs bind.
func windowSeconds(window string) (uint32, error) {
	switch window {
	case "5m":
		return 300, nil
	case "15m":
		return 900, nil
	case "30m":
		return 1800, nil
	case "1h":
		return 3600, nil
	default:
		return 0, fmt.Errorf("%w: window %q", ErrInvalidCondition, window)
	}
}
