package alerting

// deliverer.go — D490: delivery decoupled from evaluation.
//
// The evaluator writes event rows and stops. This loop, on its own 5s ticker,
// claims `pending` rows with `FOR UPDATE SKIP LOCKED`, makes ONE attempt each
// through internal/notify, and writes back what happened. At-least-once
// therefore survives every crash point: the durable row is the queue, the
// `attempts` column is the retry state, and nothing depends on a post-commit
// callback outliving the process that made it.
//
// The retry policy is the tick itself. internal/notify makes one attempt per
// call and holds no backoff (its package comment says why: a Deliverer that
// retried internally would make `attempts` lie about how many times a
// customer's endpoint was actually hit), so a failed delivery simply stays
// pending and is claimed again five seconds later, up to maxAttempts. Tick
// spacing IS the backoff, which means it is visible in the row rather than
// held in a goroutine's memory.
//
// A rate-limited delivery burns an attempt like any other failure. That is a
// deliberate reading of D487's cap: the cap exists to bound what this process
// can do to a third party, and a workspace that trips it is either firing sixty
// rules a minute or being abused — retrying past three either way is us
// deciding to keep dialing.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/notify"
)

const (
	// DeliverInterval is D490's cadence: the metering flusher's five seconds,
	// for the same reason — short enough that a customer's alert is not sitting
	// in a table while their service burns, long enough that a dead endpoint is
	// dialed three times over fifteen seconds rather than three times over
	// three milliseconds.
	DeliverInterval = 5 * time.Second

	// maxAttempts is where a pending event becomes a `failed` one. Rendered
	// honestly in the feed (D485/D13): a dead webhook is a thing the customer
	// needs to see, not a thing we retry until it is true.
	maxAttempts = 3

	// deliverTimeout bounds ONE attempt. internal/notify sets no client
	// timeout of its own — the context is the only bound, by design — so this
	// constant is the whole answer to "how long can a customer's endpoint hold
	// this loop".
	deliverTimeout = 5 * time.Second

	// deliverBatch caps one tick's claimed set, and with it how long the
	// claiming transaction can stay open: batch × deliverTimeout in the worst
	// case where every endpoint hangs to its deadline. The lock has to be held
	// across the attempt — that is what stops two replicas delivering the same
	// event — so the cap is the bound on that, not a throughput knob.
	deliverBatch = 10
)

// Delivery outcomes, ops-side. internal/notify counts its own attempts
// (obstack_ingest_notify_*); this counts the LOOP's verdicts, which is a
// different question: "delivered" here means a row moved, and "retrying" is a
// state notify has no concept of.
var deliveries = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "obstack_ingest_alert_deliveries_total",
	Help: "Alert event delivery attempts by outcome: delivered, retrying (still pending), failed (no deliverable channel, or the attempt cap reached).",
}, []string{"outcome"})

const (
	outcomeDelivered = "delivered"
	outcomeRetrying  = "retrying"
	outcomeFailed    = "failed"
)

// Notifier is the one method this loop needs from internal/notify, declared
// here because that is where the substitution happens (accept interfaces,
// return structs — notify.Deliverer is deliberately a struct).
type Notifier interface {
	Deliver(ctx context.Context, d notify.Delivery) error
}

// Deliverer drains pending alert events.
type Deliverer struct {
	pool     *pgxpool.Pool
	notifier Notifier
}

// NewDeliverer builds the loop. The notifier carries the egress policy
// (D492): strict unless the environment says otherwise, resolved once at boot
// by the caller so a malformed value fails the process rather than a delivery.
func NewDeliverer(pool *pgxpool.Pool, n Notifier) *Deliverer {
	return &Deliverer{pool: pool, notifier: n}
}

// Run drains every DeliverInterval until the context is cancelled. Like the
// evaluator there is no final pass: an abandoned tick rolls back whole and its
// events are still pending for the next process to claim, which is precisely
// what the durable row is for.
func (d *Deliverer) Run(ctx context.Context) {
	ticker := time.NewTicker(DeliverInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := d.DeliverPending(ctx); err != nil && ctx.Err() == nil {
				slog.Error("alert delivery tick failed", "error", err)
			}
		case <-ctx.Done():
			return
		}
	}
}

// claimPendingSQL claims a batch of undelivered events together with everything
// needed to deliver them: the channel captured on the row at emit time (D491)
// and the rule, if the event has one.
//
// LEFT JOINs, both of them, because both absences are real states this loop has
// to answer for: a channel deleted after the event was emitted (FK SET NULL)
// and a rule-less test notification (D491). `FOR UPDATE OF e` locks only the
// event rows — Postgres refuses a lock on the nullable side of an outer join,
// and locking a channel or a rule here would block the web tier's edits behind
// a webhook's response time for no gain.
//
// S7.3 (D512): a third LEFT JOIN, to the SLO an event may belong to instead of
// a rule (D511 — never both, the 0012 CHECK). Its name, objective fields and
// status ride into the payload's additive `slo` key.
const claimPendingSQL = `
	SELECT e.id, e.workspace_id, e.rule_id, e.channel_id, e.title, e.detail, e.link,
	       e.attempts, e.created_at,
	       c.kind, c.target, c.enabled,
	       r.name, r.severity, r.condition,
	       e.slo_id, s.name, s.indicator, s.target::float8, s.eval_window, s.status
	  FROM alert_events e
	  LEFT JOIN notification_channels c ON c.id = e.channel_id
	  LEFT JOIN alert_rules r ON r.id = e.rule_id
	  LEFT JOIN slos s ON s.id = e.slo_id
	 WHERE e.delivery = 'pending' AND e.attempts < $1
	 ORDER BY e.created_at, e.id
	 LIMIT $2
	   FOR UPDATE OF e SKIP LOCKED`

const markSQL = `UPDATE alert_events SET delivery = $2, attempts = $3 WHERE id = $1`

// pendingEvent is one claimed row, joined.
type pendingEvent struct {
	id          string
	workspaceID string
	ruleID      *string
	channelID   *string
	title       string
	detail      string
	link        *string
	attempts    int16
	createdAt   time.Time

	channelKind    *string
	channelTarget  *string
	channelEnabled *bool

	ruleName      *string
	ruleSeverity  *string
	ruleCondition []byte

	sloID        *string
	sloName      *string
	sloIndicator []byte
	sloTarget    *float64
	sloWindow    *string
	sloStatus    *string
}

// deliverable reports whether this event has somewhere to go. A NULL
// channel_id (the channel was deleted after the event was emitted) and a
// disabled channel are the same answer: nothing will ever deliver this, so it
// fails now rather than three attempts from now.
func (p pendingEvent) deliverable() bool {
	return p.channelID != nil && p.channelKind != nil && p.channelTarget != nil &&
		p.channelEnabled != nil && *p.channelEnabled
}

// DeliverPending runs one tick. Exported for the same reason EvaluateDue is:
// the drive and the tests drive the loop directly rather than waiting on a
// ticker.
func (d *Deliverer) DeliverPending(ctx context.Context) error {
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin alert delivery: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // a rollback after commit is a no-op

	pending, err := claimPending(ctx, tx)
	if err != nil {
		return err
	}
	for _, e := range pending {
		if err := d.deliverOne(ctx, tx, e); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func claimPending(ctx context.Context, tx pgx.Tx) ([]pendingEvent, error) {
	rows, err := tx.Query(ctx, claimPendingSQL, int16(maxAttempts), deliverBatch)
	if err != nil {
		return nil, fmt.Errorf("claim pending alert events: %w", err)
	}
	defer rows.Close()

	var pending []pendingEvent
	for rows.Next() {
		var e pendingEvent
		if err := rows.Scan(&e.id, &e.workspaceID, &e.ruleID, &e.channelID, &e.title, &e.detail,
			&e.link, &e.attempts, &e.createdAt,
			&e.channelKind, &e.channelTarget, &e.channelEnabled,
			&e.ruleName, &e.ruleSeverity, &e.ruleCondition,
			&e.sloID, &e.sloName, &e.sloIndicator, &e.sloTarget, &e.sloWindow, &e.sloStatus); err != nil {
			return nil, fmt.Errorf("scan pending alert event: %w", err)
		}
		pending = append(pending, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("claim pending alert events: %w", err)
	}
	return pending, nil
}

// deliverOne makes at most one attempt and writes the verdict. Its error return
// is reserved for POSTGRES failures: a refused, rate-limited or unreachable
// endpoint is a delivery outcome, not a tick failure.
func (d *Deliverer) deliverOne(ctx context.Context, tx pgx.Tx, e pendingEvent) error {
	if !d.deliverableOrFailed(ctx, e) {
		deliveries.WithLabelValues(outcomeFailed).Inc()
		return mark(ctx, tx, e.id, "failed", e.attempts)
	}

	attemptCtx, cancel := context.WithTimeout(ctx, deliverTimeout)
	defer cancel()

	err := d.notifier.Deliver(attemptCtx, notify.Delivery{
		ChannelKind: *e.channelKind,
		Target:      *e.channelTarget,
		Payload:     payloadFor(e),
	})
	attempts := e.attempts + 1

	if err == nil {
		deliveries.WithLabelValues(outcomeDelivered).Inc()
		return mark(ctx, tx, e.id, "delivered", attempts)
	}

	// Nothing here logs the target: it is a credential (D487), and the errors
	// notify returns already name only its masked rendering.
	slog.Warn("alert delivery attempt failed",
		"workspace", e.workspaceID, "event", e.id, "attempt", attempts,
		"refused", errors.Is(err, notify.ErrRefused),
		"rate_limited", errors.Is(err, notify.ErrRateLimited),
		"error", err)

	if attempts >= maxAttempts {
		deliveries.WithLabelValues(outcomeFailed).Inc()
		return mark(ctx, tx, e.id, "failed", attempts)
	}
	deliveries.WithLabelValues(outcomeRetrying).Inc()
	return mark(ctx, tx, e.id, "pending", attempts)
}

// deliverableOrFailed logs the one case worth an operator's attention before
// returning the verdict.
func (d *Deliverer) deliverableOrFailed(_ context.Context, e pendingEvent) bool {
	if e.deliverable() {
		return true
	}
	slog.Warn("alert event has no deliverable channel",
		"workspace", e.workspaceID, "event", e.id,
		"channel_missing", e.channelID == nil || e.channelKind == nil)
	return false
}

// payloadFor builds the versioned document (D486). A rule-less event — D491's
// test notification — passes Rule as nil, which T3's payload shape renders as
// `"rule":null` rather than a fabricated rule with an invented severity.
func payloadFor(e pendingEvent) notify.Payload {
	p := notify.Payload{
		Version:   notify.PayloadVersion,
		Workspace: e.workspaceID,
		Event: notify.EventPayload{
			Title:  e.title,
			Detail: e.detail,
			At:     e.createdAt.UTC(),
		},
	}
	if e.link != nil {
		p.Event.Link = *e.link
	}
	if e.ruleID != nil && e.ruleName != nil && e.ruleSeverity != nil {
		rule := &notify.RulePayload{Name: *e.ruleName, Severity: *e.ruleSeverity}
		// A condition that no longer parses does not stop the delivery: the
		// event already happened, and the receiver needs the alert more than it
		// needs the restatement.
		if cond, err := ParseCondition(e.ruleCondition); err == nil {
			rule.Condition = conditionSummary(cond)
		}
		p.Rule = rule
	}
	// S7.3 (D512): an SLO's transition names the SLO instead — `rule` stays
	// null. The objective is the Go restatement (slo_text.go's seam); a
	// document that no longer parses leaves it empty rather than stopping
	// the delivery, the same reasoning as the rule's condition.
	if e.sloID != nil && e.sloName != nil && e.sloStatus != nil {
		slo := &notify.SloPayload{Name: *e.sloName, Status: *e.sloStatus}
		if ind, err := ParseIndicator(e.sloIndicator); err == nil && e.sloTarget != nil && e.sloWindow != nil {
			slo.Objective = sloObjective(ind, *e.sloTarget, *e.sloWindow)
		}
		p.Slo = slo
	}
	return p
}

func mark(ctx context.Context, tx pgx.Tx, eventID, delivery string, attempts int16) error {
	if _, err := tx.Exec(ctx, markSQL, eventID, delivery, attempts); err != nil {
		return fmt.Errorf("mark alert event %s %s: %w", eventID, delivery, err)
	}
	return nil
}

// newEventID mirrors the web tier's id shape (dashboards.ts's
// `dash_<16 hex>`), so an id is recognisable as an alert event wherever it
// turns up.
func newEventID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failing is not a condition to degrade through: a
		// predictable id here would be a predictable row key in a
		// customer-visible table.
		panic("alerting: crypto/rand failed: " + err.Error())
	}
	return "evt_" + hex.EncodeToString(b[:])
}
