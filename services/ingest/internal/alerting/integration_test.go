package alerting

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/migrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/notify"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pgmigrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/migrations"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/pgmigrations"
)

// The evaluator's proof lives here rather than against fakes because the two
// things it actually promises — one event per crossing, and never two replicas
// evaluating one rule — are properties of a real transaction against a real
// Postgres, and the eval legs are SQL against a real ClickHouse (the retention
// integration suite's posture, and its DSN conventions verbatim).
//
// Defaults are the compose stack; both DSNs override for CI. Without a
// reachable server the tests skip, the standing convention.
const (
	defaultClickHouseDSN = "clickhouse://obstack_ingest:obstack_ingest_dev@127.0.0.1:9000/obstack"
	defaultPostgresDSN   = "postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack"
)

func chTestDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_CLICKHOUSE_DSN"); dsn != "" {
		return dsn
	}
	return defaultClickHouseDSN
}

func pgTestDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_POSTGRES_DSN"); dsn != "" {
		return dsn
	}
	return defaultPostgresDSN
}

func connectClickHouse(t *testing.T) driver.Conn {
	t.Helper()

	opts, err := clickhouse.ParseDSN(chTestDSN())
	if err != nil {
		t.Fatalf("parse ClickHouse test DSN: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	probeOpts := *opts
	probeOpts.Auth.Database = "default"
	probe, err := clickhouse.Open(&probeOpts)
	if err != nil {
		t.Fatalf("open clickhouse: %v", err)
	}
	if err := probe.Ping(ctx); err != nil {
		probe.Close()
		t.Skipf("no ClickHouse at %s (%v); start deploy/compose to run the alerting integration tests", chTestDSN(), err)
	}
	probe.Close()

	if _, err := migrate.Run(ctx, chTestDSN(), migrations.FS); err != nil {
		t.Fatalf("apply schema: %v", err)
	}

	conn, err := clickhouse.Open(opts)
	if err != nil {
		t.Fatalf("open clickhouse: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// migratedPGSchema is the keystore/retention isolation pattern: a throwaway
// schema with the whole embedded set applied, its name travelling as
// search_path so every pooled connection lands in it.
func migratedPGSchema(ctx context.Context, t *testing.T) string {
	t.Helper()

	pingCtx, cancelPing := context.WithTimeout(ctx, 5*time.Second)
	defer cancelPing()
	probe, err := pgx.Connect(pingCtx, pgTestDSN())
	if err != nil {
		t.Skipf("no Postgres at %s (%v); start deploy/compose to run the alerting integration tests", pgTestDSN(), err)
	}
	probe.Close(ctx)

	name := fmt.Sprintf("alerting_test_%d", time.Now().UnixNano())
	conn, err := pgx.Connect(ctx, pgTestDSN())
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	defer conn.Close(ctx)

	if _, err := conn.Exec(ctx, "CREATE SCHEMA "+name); err != nil {
		t.Fatalf("create schema %s: %v", name, err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cleanup, err := pgx.Connect(cleanupCtx, pgTestDSN())
		if err != nil {
			t.Errorf("connect to drop schema %s: %v", name, err)
			return
		}
		defer cleanup.Close(cleanupCtx)
		if _, err := cleanup.Exec(cleanupCtx, "DROP SCHEMA "+name+" CASCADE"); err != nil {
			t.Errorf("drop schema %s: %v", name, err)
		}
	})

	u, err := url.Parse(pgTestDSN())
	if err != nil {
		t.Fatalf("test DSN must be a postgres:// URL for schema scoping: %v", err)
	}
	q := u.Query()
	q.Set("search_path", name)
	u.RawQuery = q.Encode()
	dsn := u.String()

	if _, err := pgmigrate.Run(ctx, dsn, pgmigrations.FS); err != nil {
		t.Fatalf("apply the embedded schema: %v", err)
	}
	return dsn
}

// fixture is one throwaway schema holding one workspace and one channel — the
// two rows every alerting test needs before it can seed a rule.
type fixture struct {
	dsn       string
	pool      *pgxpool.Pool
	workspace string
	channelID string
}

func newFixture(ctx context.Context, t *testing.T) *fixture {
	t.Helper()
	dsn := migratedPGSchema(ctx, t)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	t.Cleanup(pool.Close)

	ws := fmt.Sprintf("ws_alert_%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, "INSERT INTO workspaces (id, org_id) VALUES ($1, 'org_alert')", ws); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
	f := &fixture{dsn: dsn, pool: pool, workspace: ws}
	f.channelID = f.seedChannel(ctx, t, "ops", notify.KindWebhook, "https://hooks.example.test/services/abcd", true)
	return f
}

func (f *fixture) seedChannel(ctx context.Context, t *testing.T, name, kind, target string, enabled bool) string {
	t.Helper()
	id := fmt.Sprintf("chan_%s_%d", name, time.Now().UnixNano())
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO notification_channels (id, workspace_id, name, kind, target, enabled)
		VALUES ($1, $2, $3, $4, $5, $6)`, id, f.workspace, name, kind, target, enabled); err != nil {
		t.Fatalf("seed channel %s: %v", name, err)
	}
	return id
}

// seedRule writes one rule already DUE (next_eval_at in the past), which is the
// only state a claim test cares about.
func (f *fixture) seedRule(ctx context.Context, t *testing.T, name, condition, severity, channelID string) string {
	t.Helper()
	id := fmt.Sprintf("rule_%d", time.Now().UnixNano())
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO alert_rules (id, workspace_id, name, condition, severity, channel_id, enabled, state, next_eval_at)
		VALUES ($1, $2, $3, $4::jsonb, $5, $6, true, 'ok', now() - interval '1 second')`,
		id, f.workspace, name, condition, severity, channelID); err != nil {
		t.Fatalf("seed rule %s: %v", name, err)
	}
	return id
}

func (f *fixture) makeDue(ctx context.Context, t *testing.T, ruleID string) {
	t.Helper()
	if _, err := f.pool.Exec(ctx,
		"UPDATE alert_rules SET next_eval_at = now() - interval '1 second' WHERE id = $1", ruleID); err != nil {
		t.Fatalf("make rule due: %v", err)
	}
}

type ruleRow struct {
	state           string
	nextEvalAt      time.Time
	lastTriggeredAt *time.Time
}

func (f *fixture) rule(ctx context.Context, t *testing.T, ruleID string) ruleRow {
	t.Helper()
	var r ruleRow
	if err := f.pool.QueryRow(ctx,
		"SELECT state, next_eval_at, last_triggered_at FROM alert_rules WHERE id = $1", ruleID).
		Scan(&r.state, &r.nextEvalAt, &r.lastTriggeredAt); err != nil {
		t.Fatalf("read rule %s: %v", ruleID, err)
	}
	return r
}

type eventRow struct {
	id        string
	ruleID    *string
	channelID *string
	severity  string
	title     string
	detail    string
	link      *string
	delivery  string
	attempts  int16
}

func (f *fixture) events(ctx context.Context, t *testing.T) []eventRow {
	t.Helper()
	rows, err := f.pool.Query(ctx, `
		SELECT id, rule_id, channel_id, severity, title, detail, link, delivery, attempts
		  FROM alert_events WHERE workspace_id = $1 ORDER BY created_at, id`, f.workspace)
	if err != nil {
		t.Fatalf("read events: %v", err)
	}
	defer rows.Close()
	var out []eventRow
	for rows.Next() {
		var e eventRow
		if err := rows.Scan(&e.id, &e.ruleID, &e.channelID, &e.severity, &e.title, &e.detail,
			&e.link, &e.delivery, &e.attempts); err != nil {
			t.Fatalf("scan event: %v", err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read events: %v", err)
	}
	return out
}

// seedEvent writes one pending event the way the evaluator would (D491: the
// channel is captured at emit time), or rule-less the way sendTestNotification
// does.
func (f *fixture) seedEvent(ctx context.Context, t *testing.T, ruleID *string, channelID *string, title string) string {
	t.Helper()
	id := newEventID()
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO alert_events (id, workspace_id, rule_id, channel_id, severity, title, detail, link)
		VALUES ($1, $2, $3, $4, 'warning', $5, 'seeded', NULL)`,
		id, f.workspace, ruleID, channelID, title); err != nil {
		t.Fatalf("seed event: %v", err)
	}
	return id
}

const (
	traceP95Condition   = `{"source":"trace","signal":"p95_ms","service":null,"window":"15m","op":">","threshold":500}`
	metricGaugeAvgCond  = `{"source":"metric","metric":"svc.cpu","type":"gauge","agg":"avg","window":"15m","op":">","threshold":80,"filters":{}}`
	brokenConditionJSON = `{"source":"nonsense"}`
)

// stubEval is the seam retention's `plans`/`del` fields established: the state
// machine's proof must not depend on a ClickHouse round trip, and the eval legs
// get their own proof against real seeded data below.
func stubEval(value float64, hasData bool) func(context.Context, string, Condition) (observation, error) {
	return func(context.Context, string, Condition) (observation, error) {
		return observation{value: value, unit: "ms", hasData: hasData}, nil
	}
}

// ---- item 1 + 2: the D484 state machine ------------------------------------

func TestCrossingFiresOnceAndRecoveryResolvesOnce(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	f := newFixture(ctx, t)
	ruleID := f.seedRule(ctx, t, "p95 checkout", traceP95Condition, "critical", f.channelID)

	observed := 9214.0
	ev := &Evaluator{pool: f.pool}
	ev.eval = func(ctx context.Context, ws string, c Condition) (observation, error) {
		return observation{value: observed, unit: "ms", hasData: true}, nil
	}

	// ok -> firing: exactly one event, at the RULE's severity, with the channel
	// captured on the row (D491).
	if err := ev.EvaluateDue(ctx); err != nil {
		t.Fatalf("first tick: %v", err)
	}
	events := f.events(ctx, t)
	if len(events) != 1 {
		t.Fatalf("crossing produced %d events, want exactly 1", len(events))
	}
	if events[0].severity != "critical" {
		t.Errorf("event severity = %q, want the rule's own %q", events[0].severity, "critical")
	}
	if events[0].channelID == nil || *events[0].channelID != f.channelID {
		t.Errorf("event channel_id = %v, want the rule's channel captured at emit (D491)", events[0].channelID)
	}
	if events[0].delivery != "pending" {
		t.Errorf("event delivery = %q, want pending", events[0].delivery)
	}
	if events[0].link != nil {
		t.Errorf("event link = %v, want NULL in v1 (no unambiguous deep link)", *events[0].link)
	}
	if events[0].title != "p95 checkout: 9214ms > 500ms" {
		t.Errorf("event title = %q, want the structured composition", events[0].title)
	}
	r := f.rule(ctx, t, ruleID)
	if r.state != stateFiring {
		t.Errorf("rule state = %q after the crossing, want firing", r.state)
	}
	if r.lastTriggeredAt == nil {
		t.Error("last_triggered_at is still NULL after the crossing")
	}
	if !r.nextEvalAt.After(time.Now()) {
		t.Errorf("next_eval_at = %s, want it advanced past now", r.nextEvalAt)
	}

	// A second tick while STILL crossing: silence (D484 — an event per
	// crossing, never per tick).
	f.makeDue(ctx, t, ruleID)
	if err := ev.EvaluateDue(ctx); err != nil {
		t.Fatalf("second tick: %v", err)
	}
	if got := len(f.events(ctx, t)); got != 1 {
		t.Fatalf("a second tick while firing produced %d events in total, want the original 1", got)
	}

	// firing -> ok: exactly one resolution event, at info regardless of the
	// rule's severity.
	observed = 12
	f.makeDue(ctx, t, ruleID)
	if err := ev.EvaluateDue(ctx); err != nil {
		t.Fatalf("recovery tick: %v", err)
	}
	events = f.events(ctx, t)
	if len(events) != 2 {
		t.Fatalf("recovery produced %d events in total, want 2", len(events))
	}
	resolution := events[1]
	if resolution.severity != "info" {
		t.Errorf("resolution severity = %q, want info (D484)", resolution.severity)
	}
	if resolution.title != "p95 checkout: resolved" {
		t.Errorf("resolution title = %q, want %q", resolution.title, "p95 checkout: resolved")
	}
	if got := f.rule(ctx, t, ruleID).state; got != stateOK {
		t.Errorf("rule state = %q after recovery, want ok", got)
	}

	// And silence again while it stays ok.
	f.makeDue(ctx, t, ruleID)
	if err := ev.EvaluateDue(ctx); err != nil {
		t.Fatalf("post-recovery tick: %v", err)
	}
	if got := len(f.events(ctx, t)); got != 2 {
		t.Fatalf("a tick while ok produced %d events in total, want the original 2", got)
	}
}

// ---- item 3: two claimers, one rule (D478) ---------------------------------

func TestTwoConcurrentClaimersNeverDoubleEvaluateOneRule(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	f := newFixture(ctx, t)
	f.seedRule(ctx, t, "shared rule", traceP95Condition, "warning", f.channelID)

	// A second pool is a second CONNECTION set — the point of the test is two
	// transactions racing in the server, which one pool's own serialization
	// could otherwise hide.
	poolB, err := pgxpool.New(ctx, f.dsn)
	if err != nil {
		t.Fatalf("open second pool: %v", err)
	}
	defer poolB.Close()

	claimed := make(chan struct{})
	release := make(chan struct{})
	evA := &Evaluator{pool: f.pool}
	evA.eval = func(context.Context, string, Condition) (observation, error) {
		close(claimed)
		<-release
		return observation{value: 9000, unit: "ms", hasData: true}, nil
	}

	var bCalls int
	evB := &Evaluator{pool: poolB}
	evB.eval = func(context.Context, string, Condition) (observation, error) {
		bCalls++
		return observation{value: 9000, unit: "ms", hasData: true}, nil
	}

	done := make(chan error, 1)
	go func() { done <- evA.EvaluateDue(ctx) }()

	select {
	case <-claimed:
	case <-time.After(30 * time.Second):
		t.Fatal("claimer A never reached its evaluation")
	}

	// A holds the row lock in an open transaction. B's tick must find nothing.
	if err := evB.EvaluateDue(ctx); err != nil {
		t.Fatalf("claimer B: %v", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("claimer A: %v", err)
	}

	if bCalls != 0 {
		t.Errorf("claimer B evaluated the rule %d times while A held it, want 0 (FOR UPDATE SKIP LOCKED)", bCalls)
	}
	if got := len(f.events(ctx, t)); got != 1 {
		t.Errorf("two concurrent claimers produced %d events, want exactly 1", got)
	}
}

// ---- item 4: the D480 fail-open path ---------------------------------------

func TestEvalFailureLeavesStateAndEmitsNothing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	for _, tc := range []struct {
		name      string
		condition string
		eval      func(context.Context, string, Condition) (observation, error)
	}{
		{
			name:      "clickhouse unreachable",
			condition: traceP95Condition,
			eval: func(context.Context, string, Condition) (observation, error) {
				return observation{}, fmt.Errorf("dial clickhouse: connection refused")
			},
		},
		{
			// A row can predate any schema change, so the parse runs on claim
			// and a failure is the SAME fail-open path, never a panic.
			name:      "unparseable condition",
			condition: brokenConditionJSON,
			eval:      stubEval(0, true),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(ctx, t)
			ruleID := f.seedRule(ctx, t, "failing rule", tc.condition, "critical", f.channelID)
			before := f.rule(ctx, t, ruleID)
			failedBefore := testutil.ToFloat64(evalsFailed)

			ev := &Evaluator{pool: f.pool, eval: tc.eval}
			if err := ev.EvaluateDue(ctx); err != nil {
				t.Fatalf("tick: %v", err)
			}

			after := f.rule(ctx, t, ruleID)
			if after.state != before.state {
				t.Errorf("state moved to %q on an eval failure, want it unchanged at %q", after.state, before.state)
			}
			if after.lastTriggeredAt != nil {
				t.Error("last_triggered_at was stamped by a failed evaluation")
			}
			if !after.nextEvalAt.After(before.nextEvalAt) {
				t.Errorf("next_eval_at = %s, want it advanced past %s", after.nextEvalAt, before.nextEvalAt)
			}
			if got := len(f.events(ctx, t)); got != 0 {
				t.Errorf("a failed evaluation produced %d events, want 0 (D480)", got)
			}
			if got := testutil.ToFloat64(evalsFailed) - failedBefore; got != 1 {
				t.Errorf("obstack_ingest_alert_evals_failed_total advanced by %v, want 1", got)
			}
		})
	}
}

// ---- item 5 (stub half): an empty window is not a measured zero ------------

func TestNoDataEmitsNothingAndCounts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	f := newFixture(ctx, t)
	// The threshold is one a measured ZERO would cross, so a no-data window
	// read as zero fires and this test goes red.
	ruleID := f.seedRule(ctx, t,
		"quiet rule",
		`{"source":"trace","signal":"error_rate_pct","service":null,"window":"15m","op":"<","threshold":5}`,
		"warning", f.channelID)
	before := f.rule(ctx, t, ruleID)
	noDataBefore := testutil.ToFloat64(evalsNoData)

	ev := &Evaluator{pool: f.pool, eval: stubEval(0, false)}
	if err := ev.EvaluateDue(ctx); err != nil {
		t.Fatalf("tick: %v", err)
	}

	if got := len(f.events(ctx, t)); got != 0 {
		t.Errorf("a no-data window produced %d events, want 0 (D13)", got)
	}
	after := f.rule(ctx, t, ruleID)
	if after.state != before.state {
		t.Errorf("state moved to %q on a no-data window, want it unchanged", after.state)
	}
	if !after.nextEvalAt.After(before.nextEvalAt) {
		t.Error("next_eval_at was not advanced past a no-data window")
	}
	if got := testutil.ToFloat64(evalsNoData) - noDataBefore; got != 1 {
		t.Errorf("obstack_ingest_alert_evals_nodata_total advanced by %v, want 1", got)
	}
}

// ---- item 6: the deliverer (D490/D491) -------------------------------------

// testPolicy is the D492 injected policy, set IN the test: an httptest server
// listens on loopback, which the default policy refuses on two counts.
func testPolicy(t *testing.T) notify.Policy {
	t.Helper()
	t.Setenv(notify.EnvAllowPrivate, "true")
	p, err := notify.PolicyFromEnv()
	if err != nil {
		t.Fatalf("policy from env: %v", err)
	}
	return p
}

func TestDelivererDeliversPendingEvents(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	bodies := make(chan []byte, 4)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		bodies <- body
		w.WriteHeader(http.StatusNoContent)
	}))
	defer receiver.Close()

	f := newFixture(ctx, t)
	channelID := f.seedChannel(ctx, t, "local", notify.KindWebhook, receiver.URL+"/hook/abcd", true)
	ruleID := f.seedRule(ctx, t, "p95 checkout", traceP95Condition, "critical", channelID)
	f.seedEvent(ctx, t, &ruleID, &channelID, "p95 checkout: 9214ms > 500ms")

	d := NewDeliverer(f.pool, notify.New(testPolicy(t)))
	if err := d.DeliverPending(ctx); err != nil {
		t.Fatalf("deliver: %v", err)
	}

	events := f.events(ctx, t)
	if len(events) != 1 || events[0].delivery != "delivered" {
		t.Fatalf("event delivery = %v, want one delivered", events)
	}

	select {
	case body := <-bodies:
		var payload notify.Payload
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("receiver got a body that is not the versioned document: %v (%s)", err, body)
		}
		if payload.Version != notify.PayloadVersion {
			t.Errorf("payload version = %d, want %d", payload.Version, notify.PayloadVersion)
		}
		if payload.Workspace != f.workspace {
			t.Errorf("payload workspace = %q, want %q", payload.Workspace, f.workspace)
		}
		if payload.Rule == nil || payload.Rule.Name != "p95 checkout" || payload.Rule.Severity != "critical" {
			t.Errorf("payload rule = %+v, want the rule's own name and severity", payload.Rule)
		}
		if payload.Event.Title != "p95 checkout: 9214ms > 500ms" {
			t.Errorf("payload event title = %q", payload.Event.Title)
		}
	default:
		t.Fatal("the receiver was never called")
	}
}

func TestDelivererMarksFailedAtThreeAttempts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	f := newFixture(ctx, t)
	// Port 1 on loopback: nothing listens, so the dial fails immediately —
	// the unroutable target without a DNS timeout in the test's way.
	channelID := f.seedChannel(ctx, t, "dead", notify.KindWebhook, "http://127.0.0.1:1/hook/dead", true)
	ruleID := f.seedRule(ctx, t, "dead channel rule", traceP95Condition, "warning", channelID)
	eventID := f.seedEvent(ctx, t, &ruleID, &channelID, "dead channel rule: 900ms > 500ms")

	d := NewDeliverer(f.pool, notify.New(testPolicy(t)))
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err := d.DeliverPending(ctx); err != nil {
			t.Fatalf("deliver attempt %d: %v", attempt, err)
		}
		events := f.events(ctx, t)
		if len(events) != 1 || events[0].id != eventID {
			t.Fatalf("attempt %d: events = %v", attempt, events)
		}
		if int(events[0].attempts) != attempt {
			t.Fatalf("attempt %d: attempts column = %d, want %d", attempt, events[0].attempts, attempt)
		}
		want := "pending"
		if attempt == maxAttempts {
			want = "failed"
		}
		if events[0].delivery != want {
			t.Fatalf("attempt %d: delivery = %q, want %q", attempt, events[0].delivery, want)
		}
	}

	// A failed event is done: a fourth tick must not touch it again.
	if err := d.DeliverPending(ctx); err != nil {
		t.Fatalf("fourth tick: %v", err)
	}
	if got := f.events(ctx, t)[0].attempts; got != maxAttempts {
		t.Errorf("a failed event was attempted again (attempts = %d)", got)
	}
}

func TestDelivererSendsRuleLessEventsWithNullRule(t *testing.T) {
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
	channelID := f.seedChannel(ctx, t, "test-notify", notify.KindWebhook, receiver.URL+"/hook/wxyz", true)
	f.seedEvent(ctx, t, nil, &channelID, "Test notification")

	d := NewDeliverer(f.pool, notify.New(testPolicy(t)))
	if err := d.DeliverPending(ctx); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if got := f.events(ctx, t)[0].delivery; got != "delivered" {
		t.Fatalf("rule-less event delivery = %q, want delivered", got)
	}

	select {
	case body := <-bodies:
		// D491 + T3's ruling: a rule-less event emits `"rule":null`, never a
		// fabricated empty rule with an invented severity.
		if !jsonHasNullRule(t, body) {
			t.Errorf("rule-less payload = %s, want \"rule\":null", body)
		}
	default:
		t.Fatal("the receiver was never called")
	}
}

func jsonHasNullRule(t *testing.T, body []byte) bool {
	t.Helper()
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("payload is not JSON: %v", err)
	}
	v, ok := raw["rule"]
	return ok && string(v) == "null"
}

func TestDelivererFailsEventsWithNoDeliverableChannel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	f := newFixture(ctx, t)
	disabled := f.seedChannel(ctx, t, "disabled", notify.KindWebhook, "https://hooks.example.test/off/abcd", false)
	f.seedEvent(ctx, t, nil, nil, "orphaned event")
	f.seedEvent(ctx, t, nil, &disabled, "disabled channel event")

	d := NewDeliverer(f.pool, notify.New(testPolicy(t)))
	if err := d.DeliverPending(ctx); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	for _, e := range f.events(ctx, t) {
		if e.delivery != "failed" {
			t.Errorf("event %q delivery = %q, want failed (no channel to deliver to)", e.title, e.delivery)
		}
	}
}

// ---- item 7: the two eval legs against seeded ClickHouse -------------------

func cleanupWorkspaceCH(t *testing.T, conn driver.Conn, workspaceID string) {
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		for _, table := range []string{
			"spans", "trace_summaries",
			"metric_points", "metric_points_1m", "metric_points_1h", "metric_series",
		} {
			if err := conn.Exec(ctx,
				"ALTER TABLE obstack."+table+" DELETE WHERE workspace_id = ?", workspaceID); err != nil {
				t.Logf("cleanup of %s for %s: %v", table, workspaceID, err)
			}
		}
	})
}

type metricPoint struct {
	name         string
	metricType   string
	unit         string
	seriesHash   uint64
	at           time.Time
	value        float64
	bounds       []float64
	bucketCounts []uint64
	hSum         float64
	hCount       uint64
	attributes   map[string]string
}

// seedMetricPoint writes a RAW metric_points row; the 1m rollup's MV fires
// synchronously on insert (the metrics.integration.test.ts note), so the leg
// reads real merged state rather than a hand-written rollup row.
func seedMetricPoint(ctx context.Context, t *testing.T, conn driver.Conn, ws string, p metricPoint) {
	t.Helper()
	if p.unit == "" {
		p.unit = "1"
	}
	if p.bounds == nil {
		p.bounds = []float64{}
	}
	if p.bucketCounts == nil {
		p.bucketCounts = []uint64{}
	}
	if p.attributes == nil {
		p.attributes = map[string]string{}
	}
	if err := conn.Exec(ctx, `INSERT INTO obstack.metric_points
		(workspace_id, name, type, unit, service, series_hash, timestamp, value,
		 is_monotonic, bounds, bucket_counts, h_sum, h_count, h_min, h_max, attributes, resource_attributes)
		VALUES (?, ?, ?, ?, 'alerting-it', ?, ?, ?, 0, ?, ?, ?, ?, 0, 0, ?, map())`,
		ws, p.name, p.metricType, p.unit, p.seriesHash, p.at, p.value,
		p.bounds, p.bucketCounts, p.hSum, p.hCount, p.attributes); err != nil {
		t.Fatalf("seed metric point %s: %v", p.name, err)
	}
}

// seedTrace writes one single-span trace through the real MV into
// trace_summaries.
func seedTrace(ctx context.Context, t *testing.T, conn driver.Conn, ws, traceID, service string, at time.Time, durationMs float64, errored bool) {
	t.Helper()
	status := "unset"
	if errored {
		status = "error"
	}
	if err := conn.Exec(ctx, `INSERT INTO obstack.spans
		(workspace_id, trace_id, span_id, parent_span_id, name, service, start_time, duration_ns, status_code)
		VALUES (?, ?, ?, '', 'op', ?, ?, ?, ?)`,
		ws, traceID, "s-"+traceID, service, at, uint64(durationMs*1e6), status); err != nil {
		t.Fatalf("seed trace %s: %v", traceID, err)
	}
}

func newEvaluatorAgainstCompose(ctx context.Context, t *testing.T, pool *pgxpool.Pool) *Evaluator {
	t.Helper()
	ev, err := New(ctx, Config{DSN: chTestDSN(), Pool: pool})
	if err != nil {
		t.Fatalf("new evaluator: %v", err)
	}
	t.Cleanup(ev.Close)
	return ev
}

func TestMetricLegObservesTheWindow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	conn := connectClickHouse(t)
	f := newFixture(ctx, t)
	other := f.workspace + "_b"
	cleanupWorkspaceCH(t, conn, f.workspace)
	cleanupWorkspaceCH(t, conn, other)

	at := time.Now().UTC().Add(-30 * time.Second)
	name := fmt.Sprintf("it.gauge.%d", time.Now().UnixNano())
	for _, v := range []float64{10, 20, 30} {
		seedMetricPoint(ctx, t, conn, f.workspace, metricPoint{
			name: name, metricType: "gauge", unit: "%", seriesHash: 1, at: at, value: v,
			attributes: map[string]string{"env": "prod"},
		})
	}
	// A second series the filter must exclude, and a second WORKSPACE the
	// workspace_id-first predicate must exclude (D7/D11, proven red per leg).
	seedMetricPoint(ctx, t, conn, f.workspace, metricPoint{
		name: name, metricType: "gauge", unit: "%", seriesHash: 2, at: at, value: 9000,
		attributes: map[string]string{"env": "staging"},
	})
	seedMetricPoint(ctx, t, conn, other, metricPoint{
		name: name, metricType: "gauge", unit: "%", seriesHash: 3, at: at, value: 9000,
		attributes: map[string]string{"env": "prod"},
	})

	// A histogram series for the quantile-merge leg, the same known
	// distribution metrics.test.ts pins histogramQuantile against.
	histName := fmt.Sprintf("it.hist.%d", time.Now().UnixNano())
	seedMetricPoint(ctx, t, conn, f.workspace, metricPoint{
		name: histName, metricType: "histogram", unit: "ms", seriesHash: 4, at: at,
		bounds: []float64{0, 10, 20, 30, 40}, bucketCounts: []uint64{0, 10, 10, 10, 10, 0},
		hSum: 800, hCount: 40,
	})

	ev := newEvaluatorAgainstCompose(ctx, t, f.pool)

	for _, tc := range []struct {
		name      string
		condition string
		want      float64
		wantUnit  string
	}{
		{
			name:      "gauge avg over the filtered series",
			condition: fmt.Sprintf(`{"source":"metric","metric":%q,"type":"gauge","agg":"avg","window":"15m","op":">","threshold":1,"filters":{"env":"prod"}}`, name),
			want:      20,
			wantUnit:  "%",
		},
		{
			name:      "gauge max over the filtered series",
			condition: fmt.Sprintf(`{"source":"metric","metric":%q,"type":"gauge","agg":"max","window":"15m","op":">","threshold":1,"filters":{"env":"prod"}}`, name),
			want:      30,
			wantUnit:  "%",
		},
		{
			name:      "histogram p50 through the merged bucket counts",
			condition: fmt.Sprintf(`{"source":"metric","metric":%q,"type":"histogram","agg":"p50","window":"15m","op":">","threshold":1,"filters":{}}`, histName),
			want:      20,
			wantUnit:  "ms",
		},
		{
			name:      "histogram avg is h_sum over h_count",
			condition: fmt.Sprintf(`{"source":"metric","metric":%q,"type":"histogram","agg":"avg","window":"15m","op":">","threshold":1,"filters":{}}`, histName),
			want:      20,
			wantUnit:  "ms",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cond, err := ParseCondition([]byte(tc.condition))
			if err != nil {
				t.Fatalf("parse condition: %v", err)
			}
			obs, err := ev.eval(ctx, f.workspace, cond)
			if err != nil {
				t.Fatalf("evaluate: %v", err)
			}
			if !obs.hasData {
				t.Fatal("seeded window reported no data")
			}
			if obs.value != tc.want {
				t.Errorf("observed %v, want %v", obs.value, tc.want)
			}
			if obs.unit != tc.wantUnit {
				t.Errorf("observed unit %q, want %q", obs.unit, tc.wantUnit)
			}
		})
	}
}

func TestTraceLegObservesErrorRateAndP95(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	conn := connectClickHouse(t)
	f := newFixture(ctx, t)
	other := f.workspace + "_b"
	cleanupWorkspaceCH(t, conn, f.workspace)
	cleanupWorkspaceCH(t, conn, other)

	at := time.Now().UTC().Add(-30 * time.Second)
	stamp := time.Now().UnixNano()
	// Four single-span traces from `checkout`, each 250ms, one errored:
	// 1/4 spans failed = 25%, and every trace duration identical so any
	// quantile of the set is exactly 250.
	for i := 0; i < 4; i++ {
		seedTrace(ctx, t, conn, f.workspace, fmt.Sprintf("tr_%d_%d", stamp, i), "checkout", at, 250, i == 0)
	}
	// A trace from another service (excluded by the service filter) and a
	// second workspace (excluded by workspace_id) — both would move both
	// numbers if they leaked in.
	seedTrace(ctx, t, conn, f.workspace, fmt.Sprintf("tr_%d_other", stamp), "billing", at, 9000, true)
	seedTrace(ctx, t, conn, other, fmt.Sprintf("tr_%d_ws", stamp), "checkout", at, 9000, true)

	ev := newEvaluatorAgainstCompose(ctx, t, f.pool)

	for _, tc := range []struct {
		name      string
		condition string
		want      float64
		wantUnit  string
	}{
		{
			name:      "error rate for one service",
			condition: `{"source":"trace","signal":"error_rate_pct","service":"checkout","window":"15m","op":">","threshold":1}`,
			want:      25,
			wantUnit:  "%",
		},
		{
			name:      "p95 for one service",
			condition: `{"source":"trace","signal":"p95_ms","service":"checkout","window":"15m","op":">","threshold":1}`,
			want:      250,
			wantUnit:  "ms",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cond, err := ParseCondition([]byte(tc.condition))
			if err != nil {
				t.Fatalf("parse condition: %v", err)
			}
			obs, err := ev.eval(ctx, f.workspace, cond)
			if err != nil {
				t.Fatalf("evaluate: %v", err)
			}
			if !obs.hasData {
				t.Fatal("seeded window reported no data")
			}
			if obs.value != tc.want {
				t.Errorf("observed %v, want %v", obs.value, tc.want)
			}
			if obs.unit != tc.wantUnit {
				t.Errorf("observed unit %q, want %q", obs.unit, tc.wantUnit)
			}
		})
	}
}

// ---- item 5 (real half): an empty window on BOTH legs ----------------------

func TestEmptyWindowsAreNoDataOnBothLegs(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	connectClickHouse(t)
	f := newFixture(ctx, t)
	// Nothing is seeded for this workspace at all — every read below is over a
	// genuinely empty window.

	// Both thresholds are ones a ZERO would cross, so a leg that reports an
	// empty window as 0 fires and this test goes red.
	metricRule := f.seedRule(ctx, t, "silent metric",
		`{"source":"metric","metric":"nothing.here","type":"gauge","agg":"avg","window":"15m","op":"<","threshold":1,"filters":{}}`,
		"warning", f.channelID)
	traceRule := f.seedRule(ctx, t, "silent trace",
		`{"source":"trace","signal":"error_rate_pct","service":null,"window":"15m","op":"<","threshold":1}`,
		"warning", f.channelID)

	noDataBefore := testutil.ToFloat64(evalsNoData)
	failedBefore := testutil.ToFloat64(evalsFailed)

	ev := newEvaluatorAgainstCompose(ctx, t, f.pool)
	if err := ev.EvaluateDue(ctx); err != nil {
		t.Fatalf("tick: %v", err)
	}

	if got := len(f.events(ctx, t)); got != 0 {
		t.Errorf("empty windows produced %d events, want 0 (D13: absence is not a measured zero)", got)
	}
	for _, id := range []string{metricRule, traceRule} {
		if got := f.rule(ctx, t, id).state; got != stateOK {
			t.Errorf("rule %s state = %q after an empty window, want ok", id, got)
		}
	}
	if got := testutil.ToFloat64(evalsNoData) - noDataBefore; got != 2 {
		t.Errorf("obstack_ingest_alert_evals_nodata_total advanced by %v, want 2 (one per leg)", got)
	}
	if got := testutil.ToFloat64(evalsFailed) - failedBefore; got != 0 {
		t.Errorf("an empty window counted %v eval FAILURES; no-data is not a failure", got)
	}
}
