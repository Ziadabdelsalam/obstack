package retention

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// The sweep's fan-out: every workspace hits every table with its own tier.
func TestSweepDeletesEveryTablePerWorkspace(t *testing.T) {
	type call struct {
		table       string
		workspaceID string
		days        int32
	}
	var calls []call

	s := &Sweeper{
		plans: func(context.Context) ([]workspaceRetention, error) {
			return []workspaceRetention{
				{workspaceID: "w_free", retentionDays: 7},
				{workspaceID: "w_pro", retentionDays: 30},
			}, nil
		},
		del: func(_ context.Context, table, _, workspaceID string, days int32) error {
			calls = append(calls, call{table, workspaceID, days})
			return nil
		},
	}
	s.Sweep(context.Background())

	want := []call{
		{"spans", "w_free", 7}, {"logs", "w_free", 7}, {"trace_summaries", "w_free", 7},
		{"spans", "w_pro", 30}, {"logs", "w_pro", 30}, {"trace_summaries", "w_pro", 30},
	}
	if len(calls) != len(want) {
		t.Fatalf("got %d deletes %v, want %d", len(calls), calls, len(want))
	}
	for i := range want {
		if calls[i] != want[i] {
			t.Errorf("delete %d = %v, want %v", i, calls[i], want[i])
		}
	}
}

// One workspace's failure must not starve the rest of their retention.
func TestSweepContinuesPastAFailedWorkspace(t *testing.T) {
	var swept []string
	s := &Sweeper{
		plans: func(context.Context) ([]workspaceRetention, error) {
			return []workspaceRetention{
				{workspaceID: "w_broken", retentionDays: 7},
				{workspaceID: "w_fine", retentionDays: 30},
			}, nil
		},
		del: func(_ context.Context, table, _, workspaceID string, _ int32) error {
			if workspaceID == "w_broken" {
				return errors.New("mutation queue wedged")
			}
			swept = append(swept, workspaceID+"/"+table)
			return nil
		},
	}
	s.Sweep(context.Background())

	if len(swept) != 3 {
		t.Fatalf("healthy workspace swept %v, want its 3 tables", swept)
	}
}

// A non-positive tier would delete a workspace's entire history; the sweep
// refuses it rather than trusting it.
func TestSweepRefusesNonPositiveRetention(t *testing.T) {
	deletesIssued := 0
	s := &Sweeper{
		plans: func(context.Context) ([]workspaceRetention, error) {
			return []workspaceRetention{{workspaceID: "w", retentionDays: 0}}, nil
		},
		del: func(context.Context, string, string, string, int32) error {
			deletesIssued++
			return nil
		},
	}
	s.Sweep(context.Background())

	if deletesIssued != 0 {
		t.Fatalf("issued %d deletes for a zero-day tier, want 0", deletesIssued)
	}
}

// A failed plan read is a skipped sweep, never a sweep with invented tiers.
func TestSweepSkipsWhenPlansUnreadable(t *testing.T) {
	s := &Sweeper{
		plans: func(context.Context) ([]workspaceRetention, error) {
			return nil, errors.New("postgres away")
		},
		del: func(context.Context, string, string, string, int32) error {
			t.Fatal("deleted with no plan data")
			return nil
		},
	}
	s.Sweep(context.Background())
}

// A cancelled context stops the fan-out between statements — shutdown is never
// held hostage by the rest of a sweep.
func TestSweepStopsOnContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	deletesIssued := 0
	s := &Sweeper{
		plans: func(context.Context) ([]workspaceRetention, error) {
			return []workspaceRetention{
				{workspaceID: "w1", retentionDays: 7},
				{workspaceID: "w2", retentionDays: 7},
			}, nil
		},
		del: func(context.Context, string, string, string, int32) error {
			deletesIssued++
			cancel()
			return nil
		},
	}
	s.Sweep(ctx)

	if deletesIssued >= 6 {
		t.Fatalf("issued all %d deletes after cancel, want an early stop", deletesIssued)
	}
}

// The plan query carries the D163 absent-row=free rule in the SQL itself, and
// the summaries delete cuts on max_seen_date per the retained semantic.
func TestStatementsCarryTheirRules(t *testing.T) {
	if !strings.Contains(plansSQL, `COALESCE(wp.plan_id, 'free')`) {
		t.Error("plansSQL lost the D163 absent-row=free rule")
	}
	if !strings.Contains(deletes[2].sql, "max_seen_date") {
		t.Error("trace_summaries delete must cut on max_seen_date")
	}
	for _, d := range deletes {
		if !strings.Contains(d.sql, "workspace_id = ?") {
			t.Errorf("%s delete is not workspace-scoped: %s", d.table, d.sql)
		}
	}
}
