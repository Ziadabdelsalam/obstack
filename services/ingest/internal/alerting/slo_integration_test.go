package alerting

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/notify"
)

// The SLO claim's proof (S7.3 T4), on the integration_test.go harness: the
// D511/D518 transition machine against a real Postgres with the read stubbed,
// the D505/D506 read against a real seeded ClickHouse, the D478 two-claimer
// proof re-run for the slos table, and the deliverer's `slo` payload.

const (
	availAll     = `{"kind":"availability","service":null}`
	latencyAll   = `{"kind":"latency","service":null,"thresholdMs":300}`
	brokenSLOInd = `{"kind":"errors"}`
)

func stubSLO(good, total int64) func(context.Context, string, Indicator, int) (sloCounts, error) {
	return func(context.Context, string, Indicator, int) (sloCounts, error) {
		return sloCounts{good: good, total: total}, nil
	}
}

// seedSLO writes one enabled SLO already DUE, in the row's initial state
// (no-data, the DDL default) unless a status is given.
func (f *fixture) seedSLO(ctx context.Context, t *testing.T, name, indicator string, target float64, window string, channelID *string) string {
	t.Helper()
	id := fmt.Sprintf("slo_%d", time.Now().UnixNano())
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO slos (id, workspace_id, name, indicator, target, eval_window, channel_id, enabled, next_eval_at)
		VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, true, now() - interval '1 second')`,
		id, f.workspace, name, indicator, target, window, channelID); err != nil {
		t.Fatalf("seed slo %s: %v", name, err)
	}
	return id
}

func (f *fixture) makeSLODue(ctx context.Context, t *testing.T, id string) {
	t.Helper()
	if _, err := f.pool.Exec(ctx, "UPDATE slos SET next_eval_at = now() - interval '1 second' WHERE id = $1", id); err != nil {
		t.Fatalf("make slo due: %v", err)
	}
}

type sloRow struct {
	status           string
	current          *float64
	burned           *float64
	good             *int64
	total            *int64
	evaluatedAt      *time.Time
	lastTransitionAt *time.Time
	nextEvalAt       time.Time
}

func (f *fixture) slo(ctx context.Context, t *testing.T, id string) sloRow {
	t.Helper()
	var r sloRow
	if err := f.pool.QueryRow(ctx, `
		SELECT status, current_pct, budget_burned_pct, good_count, total_count, evaluated_at, last_transition_at, next_eval_at
		  FROM slos WHERE id = $1`, id).
		Scan(&r.status, &r.current, &r.burned, &r.good, &r.total, &r.evaluatedAt, &r.lastTransitionAt, &r.nextEvalAt); err != nil {
		t.Fatalf("read slo %s: %v", id, err)
	}
	return r
}

type sloEventRow struct {
	sloID    *string
	ruleID   *string
	severity string
	title    string
}

func (f *fixture) sloEvents(ctx context.Context, t *testing.T) []sloEventRow {
	t.Helper()
	rows, err := f.pool.Query(ctx, `
		SELECT slo_id, rule_id, severity, title FROM alert_events WHERE workspace_id = $1 ORDER BY created_at, id`, f.workspace)
	if err != nil {
		t.Fatalf("read events: %v", err)
	}
	defer rows.Close()
	var out []sloEventRow
	for rows.Next() {
		var e sloEventRow
		if err := rows.Scan(&e.sloID, &e.ruleID, &e.severity, &e.title); err != nil {
			t.Fatalf("scan event: %v", err)
		}
		out = append(out, e)
	}
	return out
}

// ---- D511/D518: the transition machine, with the read stubbed ----------------

func TestSloTransitionsEmitExactlyTheRuledEvents(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	f := newFixture(ctx, t)
	id := f.seedSLO(ctx, t, "API availability", availAll, 99, "30d", &f.channelID)
	ev := &Evaluator{pool: f.pool}

	tick := func(good, total int64) {
		t.Helper()
		ev.evalSLO = stubSLO(good, total)
		f.makeSLODue(ctx, t, id)
		if err := ev.EvaluateDueSLOs(ctx); err != nil {
			t.Fatalf("tick: %v", err)
		}
	}
	wantEvents := func(n int, why string) []sloEventRow {
		t.Helper()
		events := f.sloEvents(ctx, t)
		if len(events) != n {
			t.Fatalf("%s: %d events in total, want %d: %+v", why, len(events), n, events)
		}
		return events
	}

	// no-data → healthy: measured, written, SILENT (nothing to recover from).
	tick(993, 1000)
	r := f.slo(ctx, t, id)
	if r.status != statusHealthy || r.current == nil || *r.current != 99.3 || r.burned == nil || *r.burned != 70 {
		t.Fatalf("first measurement = %+v, want healthy 99.3%% / 70%%", r)
	}
	if r.good == nil || *r.good != 993 || r.total == nil || *r.total != 1000 || r.evaluatedAt == nil {
		t.Fatalf("counts/evaluated_at not written: %+v", r)
	}
	if r.lastTransitionAt == nil {
		t.Fatal("last_transition_at not stamped on the no-data → healthy change")
	}
	if !r.nextEvalAt.After(time.Now().Add(4 * time.Minute)) {
		t.Errorf("next_eval_at = %s, want ~5m out (SLOEvalInterval)", r.nextEvalAt)
	}
	wantEvents(0, "no-data → healthy")
	firstTransition := *r.lastTransitionAt

	// healthy → at-risk: warning.
	tick(992, 1000)
	events := wantEvents(1, "healthy → at-risk")
	if events[0].severity != "warning" || events[0].sloID == nil || *events[0].sloID != id || events[0].ruleID != nil {
		t.Fatalf("at-risk event = %+v, want warning with slo_id set and rule_id NULL", events[0])
	}
	if events[0].title != "API availability: at risk — 80% of the error budget consumed" {
		t.Errorf("at-risk title = %q", events[0].title)
	}
	if r = f.slo(ctx, t, id); r.status != statusAtRisk || !r.lastTransitionAt.After(firstTransition) {
		t.Fatalf("after at-risk: %+v", r)
	}

	// at-risk → breached: critical.
	tick(984, 1000)
	events = wantEvents(2, "at-risk → breached")
	if events[1].severity != "critical" || events[1].title != "API availability: breached — 98.4% against a 99% target" {
		t.Fatalf("breached event = %+v", events[1])
	}

	// still breached: silence, but the numbers move and the transition stamp does not.
	breachedAt := *f.slo(ctx, t, id).lastTransitionAt
	tick(980, 1000)
	wantEvents(2, "still breached")
	r = f.slo(ctx, t, id)
	if r.status != statusBreached || *r.current != 98 || !r.lastTransitionAt.Equal(breachedAt) {
		t.Fatalf("second breached tick: %+v (transition stamp moved: %v)", r, !r.lastTransitionAt.Equal(breachedAt))
	}

	// breached → healthy: info, a recovery.
	tick(995, 1000)
	events = wantEvents(3, "breached → healthy")
	if events[2].severity != severityInfo || events[2].title != "API availability: healthy again — 99.5% against a 99% target" {
		t.Fatalf("recovery event = %+v", events[2])
	}

	// healthy → no-data: silent; the numbers are gone, the status says so.
	tick(0, 0)
	wantEvents(3, "healthy → no-data")
	r = f.slo(ctx, t, id)
	if r.status != statusNoData || r.current != nil || r.good != nil || r.evaluatedAt == nil {
		t.Fatalf("no-data tick: %+v", r)
	}

	// D518: no-data → breached IS an event — a first (or first-after-edit)
	// measurement that is already bad is news.
	tick(900, 1000)
	events = wantEvents(4, "no-data → breached")
	if events[3].severity != "critical" {
		t.Fatalf("no-data → breached event = %+v, want critical", events[3])
	}
}

func TestSloWithoutChannelTransitionsSilently(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	f := newFixture(ctx, t)
	id := f.seedSLO(ctx, t, "quiet objective", latencyAll, 99, "7d", nil)
	ev := &Evaluator{pool: f.pool, evalSLO: stubSLO(900, 1000)}
	if err := ev.EvaluateDueSLOs(ctx); err != nil {
		t.Fatalf("tick: %v", err)
	}
	r := f.slo(ctx, t, id)
	if r.status != statusBreached || r.lastTransitionAt == nil {
		t.Fatalf("channel-less slo = %+v, want breached with a transition stamp", r)
	}
	if got := len(f.sloEvents(ctx, t)); got != 0 {
		t.Fatalf("a channel-less slo produced %d events, want 0 (D511)", got)
	}
}

func TestSloEvalFailureAndNoDataLeaveTheMeasurementAlone(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	for _, tc := range []struct {
		name      string
		indicator string
		window    string
		eval      func(context.Context, string, Indicator, int) (sloCounts, error)
	}{
		{"clickhouse unreachable", availAll, "7d", func(context.Context, string, Indicator, int) (sloCounts, error) {
			return sloCounts{}, fmt.Errorf("dial clickhouse: connection refused")
		}},
		{"unparseable indicator", brokenSLOInd, "7d", stubSLO(0, 1000)},
		{"window outside the vocabulary", availAll, "90d", stubSLO(0, 1000)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(ctx, t)
			// A window the DDL would refuse is written around the CHECK for the
			// one case that needs it: the evaluator must fail open on a value
			// it does not know, however it got there.
			if tc.window == "90d" {
				if _, err := f.pool.Exec(ctx, "ALTER TABLE slos DROP CONSTRAINT slos_eval_window_check"); err != nil {
					t.Fatalf("drop window check for the test: %v", err)
				}
			}
			id := f.seedSLO(ctx, t, "failing objective", tc.indicator, 99, tc.window, &f.channelID)
			// Pretend an earlier tick measured it breached: a failure must not touch that.
			if _, err := f.pool.Exec(ctx, `UPDATE slos SET status = 'breached', current_pct = 90, budget_burned_pct = 1000, good_count = 900, total_count = 1000 WHERE id = $1`, id); err != nil {
				t.Fatalf("pre-measure: %v", err)
			}
			before := f.slo(ctx, t, id)
			failedBefore := testutil.ToFloat64(sloEvalsFailed)

			ev := &Evaluator{pool: f.pool, evalSLO: tc.eval}
			if err := ev.EvaluateDueSLOs(ctx); err != nil {
				t.Fatalf("tick: %v", err)
			}
			after := f.slo(ctx, t, id)
			if after.status != before.status || *after.current != *before.current || *after.good != *before.good {
				t.Errorf("a failed evaluation moved the measurement: %+v → %+v", before, after)
			}
			if !after.nextEvalAt.After(before.nextEvalAt) {
				t.Errorf("next_eval_at not advanced past a failure")
			}
			if got := len(f.sloEvents(ctx, t)); got != 0 {
				t.Errorf("a failed evaluation produced %d events", got)
			}
			if got := testutil.ToFloat64(sloEvalsFailed) - failedBefore; got != 1 {
				t.Errorf("obstack_ingest_slo_evals_failed_total advanced by %v, want 1", got)
			}
		})
	}

	t.Run("no data counts and moves the status, not the failure counter", func(t *testing.T) {
		f := newFixture(ctx, t)
		id := f.seedSLO(ctx, t, "empty objective", availAll, 99.9, "30d", &f.channelID)
		noDataBefore := testutil.ToFloat64(sloEvalsNoData)
		failedBefore := testutil.ToFloat64(sloEvalsFailed)
		ev := &Evaluator{pool: f.pool, evalSLO: stubSLO(0, 0)}
		if err := ev.EvaluateDueSLOs(ctx); err != nil {
			t.Fatalf("tick: %v", err)
		}
		r := f.slo(ctx, t, id)
		if r.status != statusNoData || r.current != nil || r.total != nil || r.evaluatedAt == nil {
			t.Fatalf("no-data row = %+v", r)
		}
		if got := len(f.sloEvents(ctx, t)); got != 0 {
			t.Errorf("no-data produced %d events", got)
		}
		if got := testutil.ToFloat64(sloEvalsNoData) - noDataBefore; got != 1 {
			t.Errorf("nodata counter advanced by %v, want 1", got)
		}
		if got := testutil.ToFloat64(sloEvalsFailed) - failedBefore; got != 0 {
			t.Errorf("no-data counted %v failures", got)
		}
	})
}

// ---- D478 for slos: two claimers, one SLO ------------------------------------

func TestTwoConcurrentClaimersNeverDoubleEvaluateOneSlo(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	f := newFixture(ctx, t)
	f.seedSLO(ctx, t, "shared objective", availAll, 99, "7d", &f.channelID)

	poolB, err := pgxpool.New(ctx, f.dsn)
	if err != nil {
		t.Fatalf("open second pool: %v", err)
	}
	defer poolB.Close()

	claimed := make(chan struct{})
	release := make(chan struct{})
	evA := &Evaluator{pool: f.pool}
	evA.evalSLO = func(context.Context, string, Indicator, int) (sloCounts, error) {
		close(claimed)
		<-release
		return sloCounts{good: 900, total: 1000}, nil
	}
	var bCalls int
	evB := &Evaluator{pool: poolB}
	evB.evalSLO = func(context.Context, string, Indicator, int) (sloCounts, error) {
		bCalls++
		return sloCounts{good: 900, total: 1000}, nil
	}

	done := make(chan error, 1)
	go func() { done <- evA.EvaluateDueSLOs(ctx) }()
	select {
	case <-claimed:
	case <-time.After(30 * time.Second):
		t.Fatal("claimer A never reached its read")
	}
	if err := evB.EvaluateDueSLOs(ctx); err != nil {
		t.Fatalf("claimer B: %v", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("claimer A: %v", err)
	}
	if bCalls != 0 {
		t.Errorf("claimer B read the slo %d times while A held it, want 0", bCalls)
	}
	if got := len(f.sloEvents(ctx, t)); got != 1 {
		t.Errorf("two concurrent claimers produced %d events, want exactly 1", got)
	}
}

// ---- D505/D506: the read against seeded ClickHouse --------------------------

func TestSloReadCountsTracesAgainstSeededClickHouse(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	conn := connectClickHouse(t)
	f := newFixture(ctx, t)
	other := f.workspace + "_b"
	cleanupWorkspaceCH(t, conn, f.workspace)
	cleanupWorkspaceCH(t, conn, other)

	at := time.Now().UTC().Add(-2 * time.Hour)
	stamp := time.Now().UnixNano()
	// Four checkout traces at 250ms, one errored; one billing trace at 9000ms,
	// errored; one in another workspace that must never count.
	for i := 0; i < 4; i++ {
		seedTrace(ctx, t, conn, f.workspace, fmt.Sprintf("slo_%d_%d", stamp, i), "checkout", at, 250, i == 0)
	}
	seedTrace(ctx, t, conn, f.workspace, fmt.Sprintf("slo_%d_billing", stamp), "billing", at, 9000, true)
	seedTrace(ctx, t, conn, other, fmt.Sprintf("slo_%d_ws", stamp), "checkout", at, 9000, true)

	ev := newEvaluatorAgainstCompose(ctx, t, f.pool)
	checkout := "checkout"
	for _, tc := range []struct {
		name      string
		ind       Indicator
		wantGood  int64
		wantTotal int64
	}{
		{"availability for one service", Indicator{Kind: KindAvailability, Service: &checkout}, 3, 4},
		{"availability across all services", Indicator{Kind: KindAvailability}, 3, 5},
		{"latency for one service under 300ms", Indicator{Kind: KindLatency, Service: &checkout, ThresholdMs: 300}, 4, 4},
		{"latency across all services under 300ms", Indicator{Kind: KindLatency, ThresholdMs: 300}, 4, 5},
		{"latency at exactly the trace duration is good (<=)", Indicator{Kind: KindLatency, Service: &checkout, ThresholdMs: 250}, 4, 4},
		{"latency under 200ms: nothing is good, everything is counted", Indicator{Kind: KindLatency, Service: &checkout, ThresholdMs: 200}, 0, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, days := range []int{7, 30} {
				counts, err := ev.evalSLO(ctx, f.workspace, tc.ind, days)
				if err != nil {
					t.Fatalf("read (%dd): %v", days, err)
				}
				if counts.good != tc.wantGood || counts.total != tc.wantTotal {
					t.Errorf("%dd: good/total = %d/%d, want %d/%d", days, counts.good, counts.total, tc.wantGood, tc.wantTotal)
				}
			}
		})
	}

	// The other workspace, read on its own: exactly its one trace.
	counts, err := ev.evalSLO(ctx, other, Indicator{Kind: KindAvailability}, 7)
	if err != nil {
		t.Fatalf("read other: %v", err)
	}
	if counts.good != 0 || counts.total != 1 {
		t.Errorf("other workspace good/total = %d/%d, want 0/1", counts.good, counts.total)
	}

	// And the whole tick end to end against the real read: a 99.9% objective
	// over checkout is breached (3 of 4), the event is written with the
	// measured numbers in its text.
	id := f.seedSLO(ctx, t, "Checkout availability", `{"kind":"availability","service":"checkout"}`, 99.9, "7d", &f.channelID)
	if err := ev.EvaluateDueSLOs(ctx); err != nil {
		t.Fatalf("real tick: %v", err)
	}
	r := f.slo(ctx, t, id)
	if r.status != statusBreached || r.good == nil || *r.good != 3 || *r.total != 4 || *r.current != 75 {
		t.Fatalf("real tick row = %+v, want breached 3/4 = 75%%", r)
	}
	events := f.sloEvents(ctx, t)
	if len(events) != 1 || events[0].title != "Checkout availability: breached — 75% against a 99.9% target" {
		t.Fatalf("real tick events = %+v", events)
	}
}

func TestSloReadOnAnEmptyWorkspaceIsNoData(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	connectClickHouse(t)
	f := newFixture(ctx, t)
	id := f.seedSLO(ctx, t, "nothing yet", availAll, 99.9, "30d", &f.channelID)
	ev := newEvaluatorAgainstCompose(ctx, t, f.pool)
	if err := ev.EvaluateDueSLOs(ctx); err != nil {
		t.Fatalf("tick: %v", err)
	}
	if r := f.slo(ctx, t, id); r.status != statusNoData || r.current != nil {
		t.Fatalf("empty workspace row = %+v, want no-data with no numbers", r)
	}
	if got := len(f.sloEvents(ctx, t)); got != 0 {
		t.Errorf("empty workspace produced %d events", got)
	}
}

// ---- D512: the deliverer's slo payload ----------------------------------------

func TestDelivererSendsSloEventsWithSloAndNullRule(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	bodies := make(chan []byte, 4)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		bodies <- body
		w.WriteHeader(http.StatusOK)
	}))
	defer receiver.Close()

	f := newFixture(ctx, t)
	channelID := f.seedChannel(ctx, t, "slo-hook", notify.KindWebhook, receiver.URL+"/hook/slo1", true)
	sloID := f.seedSLO(ctx, t, "API availability", `{"kind":"availability","service":"checkout"}`, 99.9, "30d", &channelID)
	if _, err := f.pool.Exec(ctx, `UPDATE slos SET status = 'breached' WHERE id = $1`, sloID); err != nil {
		t.Fatalf("set status: %v", err)
	}
	if _, err := f.pool.Exec(ctx, insertSLOEventSQL,
		newEventID(), f.workspace, sloID, channelID, "critical",
		"API availability: breached — 75% against a 99.9% target", "seeded"); err != nil {
		t.Fatalf("seed slo event: %v", err)
	}

	d := NewDeliverer(f.pool, notify.New(testPolicy(t)))
	if err := d.DeliverPending(ctx); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if got := f.events(ctx, t)[0].delivery; got != "delivered" {
		t.Fatalf("slo event delivery = %q, want delivered", got)
	}

	select {
	case body := <-bodies:
		if !jsonHasNullRule(t, body) {
			t.Errorf("slo payload = %s, want \"rule\":null", body)
		}
		var payload notify.Payload
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("payload is not the versioned document: %v", err)
		}
		if payload.Slo == nil || payload.Slo.Name != "API availability" || payload.Slo.Status != "breached" {
			t.Fatalf("payload slo = %+v", payload.Slo)
		}
		if payload.Slo.Objective != "99.9% of traces without an error span over 30d · service checkout" {
			t.Errorf("payload objective = %q", payload.Slo.Objective)
		}
		if payload.Version != notify.PayloadVersion {
			t.Errorf("version = %d", payload.Version)
		}
	default:
		t.Fatal("the receiver was never called")
	}
}

// ---- hermetic: the severity table ---------------------------------------------

func TestSloTransitionSeverityTable(t *testing.T) {
	for _, tc := range []struct {
		from, to string
		severity string
		emit     bool
	}{
		{statusNoData, statusHealthy, "", false},
		{statusNoData, statusAtRisk, "warning", true},
		{statusNoData, statusBreached, "critical", true},
		{statusHealthy, statusAtRisk, "warning", true},
		{statusHealthy, statusBreached, "critical", true},
		{statusAtRisk, statusBreached, "critical", true},
		{statusBreached, statusAtRisk, "warning", true},
		{statusAtRisk, statusHealthy, "info", true},
		{statusBreached, statusHealthy, "info", true},
		{statusBreached, statusNoData, "", false},
		{statusHealthy, statusNoData, "", false},
		{statusBreached, statusBreached, "", false},
		{statusHealthy, statusHealthy, "", false},
	} {
		sev, emit := sloTransitionSeverity(tc.from, tc.to)
		if sev != tc.severity || emit != tc.emit {
			t.Errorf("sloTransitionSeverity(%s → %s) = (%q, %v), want (%q, %v)", tc.from, tc.to, sev, emit, tc.severity, tc.emit)
		}
	}
}
