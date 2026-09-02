package alerting

// slo_evaluator.go — D510: the SLO claim, a second loop on the S7.1 ticker in
// the same package, on the same connections.
//
// The three properties evaluator.go holds for rules hold here for the same
// reasons, by the same mechanisms:
//
//   - N replicas never double-evaluate an SLO (D478): `FOR UPDATE SKIP LOCKED`
//     inside the transaction that writes the result.
//
//   - An event is produced by a TRANSITION, never by a state (D511): an SLO
//     that stays breached emits nothing after the breach; the change of
//     status is the news. D518 refines the seam with no-data: a first
//     measurement that lands in at-risk or breached IS a transition worth an
//     event, a first measurement that is healthy is not, and losing the data
//     is silent.
//
//   - An evaluation that could not be completed changes nothing (D480): the
//     status and the numbers on the row stay what they were, next_eval_at
//     advances, the failure is counted. A card that says BREACHED because
//     ClickHouse timed out would be a D13 violation aimed at a pager.
//
// What is different from rules: the evaluator WRITES the measurement the card
// renders (status, attainment, budget, counts, evaluated_at) — the web tier
// only reads them (and resets them when the objective changes, D518). And an
// SLO's channel is optional (D511): with no channel there is nowhere for an
// event to go, so none is written — the status on the card, and its
// last_transition_at, are the record.

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

const (
	// SLOEvalInterval is how far a claimed SLO is rescheduled (D510): five
	// minutes. The LOOP looks every EvalInterval (60s) — that is what makes a
	// new or re-defined objective measured within a minute — but a 30-day
	// merge every minute for a number that moves by the hour is waste, so a
	// measured SLO waits five before it is read again.
	SLOEvalInterval = 5 * time.Minute

	// sloEvalTimeout bounds one read. A 30-day merge over trace_summaries is
	// bigger than a 1-hour alert window, so the bound is larger than
	// evalTimeout — but it is still a bound, and a read past it is a failure
	// (counted, fail-open), never something to wait longer for. If this
	// counter ever moves in production on timeouts, the pre-registered answer
	// is an hourly good/total rollup, not a wider timeout (packet D510).
	sloEvalTimeout = 30 * time.Second

	// sloClaimBatch caps one tick's claimed set, the claimBatch reasoning.
	sloClaimBatch = 50
)

var (
	sloEvalsFailed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "obstack_ingest_slo_evals_failed_total",
		Help: "SLO evaluations that could not be completed — an unreachable or slow ClickHouse, or an indicator this binary cannot parse. The SLO's status and numbers are left unchanged (D480/D510).",
	})
	sloEvalsNoData = promauto.NewCounter(prometheus.CounterOpts{
		Name: "obstack_ingest_slo_evals_nodata_total",
		Help: "SLO evaluations whose window held no traces at all; the SLO is marked no-data with no numbers, and no event is emitted (D508).",
	})
)

// sloCounts is one read's answer: how many traces in the window were good,
// and how many there were. total == 0 is the no-data case.
type sloCounts struct {
	good  int64
	total int64
}

// claimSLOSQL is D478's mechanism for the slos table — deliberately
// workspace-blind for the reason claimSQL states (it schedules; the read is
// workspace_id-first). target is cast to float8 so the arithmetic gets the
// number the author typed rather than a NUMERIC string.
const claimSLOSQL = `
	SELECT id, workspace_id, name, indicator, target::float8, eval_window, channel_id, status
	  FROM slos
	 WHERE enabled AND next_eval_at <= now()
	 ORDER BY next_eval_at
	 LIMIT $1
	   FOR UPDATE SKIP LOCKED`

// rescheduleSLOSQL is the fail-open write: nothing but the clock moves.
const rescheduleSLOSQL = `
	UPDATE slos
	   SET next_eval_at = now() + make_interval(secs => $2::double precision)
	 WHERE id = $1`

// writeSLOSQL records a measurement. last_transition_at moves only when the
// status column actually changes — the CASE reads the row's OLD status, which
// is what an UPDATE's right-hand side refers to — so a card can say "breached
// since 10:14" without the loop remembering anything. NULL numbers are the
// no-data state (D508).
const writeSLOSQL = `
	UPDATE slos
	   SET status = $2, current_pct = $3, budget_burned_pct = $4, good_count = $5, total_count = $6,
	       evaluated_at = now(),
	       last_transition_at = CASE WHEN status <> $2 THEN now() ELSE last_transition_at END,
	       next_eval_at = now() + make_interval(secs => $7::double precision)
	 WHERE id = $1`

// insertSLOEventSQL writes one transition as a pending event (D511/D513): the
// SLO's row, no rule, the channel captured at emit time (D491), no link (the
// insertEventSQL reasoning).
const insertSLOEventSQL = `
	INSERT INTO alert_events (id, workspace_id, rule_id, slo_id, channel_id, severity, title, detail, link)
	VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, NULL)`

// claimedSLO is one row of the claimed set.
type claimedSLO struct {
	id          string
	workspaceID string
	name        string
	indicator   []byte
	target      float64
	window      string
	channelID   *string
	status      string
}

// EvaluateDueSLOs runs one SLO tick: claim, read, write, commit — one
// transaction, the EvaluateDue shape. Exported for the same reason.
func (e *Evaluator) EvaluateDueSLOs(ctx context.Context) error {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin slo evaluation: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // a rollback after commit is a no-op

	claimed, err := claimSLOs(ctx, tx)
	if err != nil {
		return err
	}
	for _, s := range claimed {
		if err := e.evaluateSLO(ctx, tx, s); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func claimSLOs(ctx context.Context, tx pgx.Tx) ([]claimedSLO, error) {
	rows, err := tx.Query(ctx, claimSLOSQL, sloClaimBatch)
	if err != nil {
		return nil, fmt.Errorf("claim due slos: %w", err)
	}
	defer rows.Close()

	var claimed []claimedSLO
	for rows.Next() {
		var s claimedSLO
		if err := rows.Scan(&s.id, &s.workspaceID, &s.name, &s.indicator, &s.target,
			&s.window, &s.channelID, &s.status); err != nil {
			return nil, fmt.Errorf("scan claimed slo: %w", err)
		}
		claimed = append(claimed, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("claim due slos: %w", err)
	}
	return claimed, nil
}

// evaluateSLO is one claimed SLO's tick. Its error return is reserved for
// POSTGRES failures; every way the evaluation itself can fail is the fail-open
// path — a successful tick that changed nothing but the clock.
func (e *Evaluator) evaluateSLO(ctx context.Context, tx pgx.Tx, s claimedSLO) error {
	ind, err := ParseIndicator(s.indicator)
	if err != nil {
		sloEvalsFailed.Inc()
		slog.Warn("slo indicator is not evaluable", "workspace", s.workspaceID, "slo", s.id, "error", err)
		return e.rescheduleSLO(ctx, tx, s.id)
	}
	days, err := windowDays(s.window)
	if err != nil {
		sloEvalsFailed.Inc()
		slog.Warn("slo window is not evaluable", "workspace", s.workspaceID, "slo", s.id, "error", err)
		return e.rescheduleSLO(ctx, tx, s.id)
	}

	counts, err := e.evalSLO(ctx, s.workspaceID, ind, days)
	if err != nil {
		sloEvalsFailed.Inc()
		slog.Warn("slo evaluation failed", "workspace", s.workspaceID, "slo", s.id, "kind", ind.Kind, "error", err)
		return e.rescheduleSLO(ctx, tx, s.id)
	}

	m := sloMeasure(counts.good, counts.total, s.target)
	if !m.hasData {
		// D508: a state, not a number. The status moves to no-data (so the
		// card says so) and nothing is emitted in either direction.
		sloEvalsNoData.Inc()
		return writeSLO(ctx, tx, s.id, statusNoData, nil, nil, nil, nil)
	}
	if err := writeSLO(ctx, tx, s.id, m.status, &m.current, &m.burned, &m.good, &m.total); err != nil {
		return err
	}

	// D511: no channel, no event — the card is the record.
	if s.channelID == nil {
		return nil
	}
	severity, emit := sloTransitionSeverity(s.status, m.status)
	if !emit {
		return nil
	}
	title, detail := sloTransitionText(s.name, ind, s.target, s.window, m, m.status)
	if _, err := tx.Exec(ctx, insertSLOEventSQL,
		newEventID(), s.workspaceID, s.id, *s.channelID, severity, title, detail); err != nil {
		return fmt.Errorf("insert slo event for %s: %w", s.id, err)
	}
	return nil
}

// sloTransitionSeverity decides whether a status change is an event and how
// loud (D511, refined by D518 at the no-data seam):
//
//	→ breached from anything else:            critical
//	→ at-risk  from anything else:            warning
//	→ healthy  from at-risk or breached:      info   (a recovery)
//	→ healthy  from no-data, → no-data, same: silent
func sloTransitionSeverity(from, to string) (severity string, emit bool) {
	if from == to {
		return "", false
	}
	switch to {
	case statusBreached:
		return "critical", true
	case statusAtRisk:
		return "warning", true
	case statusHealthy:
		if from == statusAtRisk || from == statusBreached {
			return severityInfo, true
		}
		return "", false
	default:
		return "", false
	}
}

func (e *Evaluator) rescheduleSLO(ctx context.Context, tx pgx.Tx, id string) error {
	if _, err := tx.Exec(ctx, rescheduleSLOSQL, id, SLOEvalInterval.Seconds()); err != nil {
		return fmt.Errorf("reschedule slo %s: %w", id, err)
	}
	return nil
}

func writeSLO(ctx context.Context, tx pgx.Tx, id, status string, current, burned *float64, good, total *int64) error {
	if _, err := tx.Exec(ctx, writeSLOSQL, id, status, current, burned, good, total, SLOEvalInterval.Seconds()); err != nil {
		return fmt.Errorf("write slo %s measurement: %w", id, err)
	}
	return nil
}

// evaluateSLOCounts is the real evalSLO: the read under its own timeout,
// sent to the server as well (the evaluateCondition posture).
func (e *Evaluator) evaluateSLOCounts(ctx context.Context, workspaceID string, ind Indicator, days int) (sloCounts, error) {
	ctx, cancel := context.WithTimeout(ctx, sloEvalTimeout)
	defer cancel()
	ctx = clickhouse.Context(ctx, clickhouse.WithSettings(clickhouse.Settings{
		"max_execution_time": int(sloEvalTimeout / time.Second),
	}))
	return e.readSLOCounts(ctx, workspaceID, ind, days)
}
