package alerting

// eval_slo.go — the D505/D506 read: good and total TRACES over the window,
// from `trace_summaries`, in the S7.1 trace leg's exact shape widened to days.
//
// The house rule eval_trace.go states binds here verbatim: GROUP BY
// workspace_id, trace_id with the matching combinators, never FINAL, never a
// bare SELECT; `max_seen_date` prunes cheaply in WHERE and the exact window
// bound is applied to the MERGED `min_start` in HAVING.
//
// Two definitions, stated because they are choices (packet D505):
//
//   - availability: a trace is good when its merged error_count is 0 — no
//     span in it errored. This is REQUEST-grained, not the span-grained error
//     rate services.ts renders; the objective sentence says "traces" so the
//     reader is told which.
//
//   - latency: a trace is good when its duration — merged max_end minus merged
//     min_start, the S7.1 p95's own definition — is at or under the threshold.
//
// The service scope is the trace leg's predicate (D506): traces that INVOLVE
// the service, with the documented caveat.
//
// PARAMETER ORDER IS TEXT ORDER: clickhouse-go binds `?` positionally, and the
// latency kind's threshold sits in the OUTER select, before the inner query's
// workspace_id. The args slice below is built in that order and says so.

import (
	"context"
	"fmt"
)

// sloCountRow is the one row the read returns.
type sloCountRow struct {
	Good  int64 `ch:"good"`
	Total int64 `ch:"total"`
}

// sloSQL builds the read for one indicator kind and scope. Every value —
// the threshold, the workspace, the window, the service — is bound.
func sloSQL(kind string, filtered bool) string {
	good := "countIf(error_spans = 0)"
	if kind == KindLatency {
		good = "countIf(duration_ms <= ?)"
	}
	serviceClause := ""
	if filtered {
		serviceClause = "\n       AND has(groupUniqArrayArray(services), ?)"
	}
	return `
SELECT
    toInt64(` + good + `) AS good,
    toInt64(count())      AS total
FROM (
    SELECT
        trace_id,
        sum(error_count) AS error_spans,
        (toUnixTimestamp64Nano(max(max_end)) - toUnixTimestamp64Nano(min(min_start))) / 1e6 AS duration_ms
    FROM obstack.trace_summaries
    WHERE workspace_id = ?
      AND max_seen_date >= toDate(now('UTC') - toIntervalDay(?))
    GROUP BY workspace_id, trace_id
    HAVING min(min_start) >= now() - toIntervalDay(?)` + serviceClause + `
)`
}

// readSLOCounts runs the read. Workspace-first (D7/D11), through binding.
func (e *Evaluator) readSLOCounts(ctx context.Context, workspaceID string, ind Indicator, days int) (sloCounts, error) {
	// Text order: [threshold], workspace, window (prune), window (exact), [service].
	var args []any
	if ind.Kind == KindLatency {
		args = append(args, float64(ind.ThresholdMs))
	}
	args = append(args, workspaceID, uint32(days), uint32(days))
	if ind.Service != nil {
		args = append(args, *ind.Service)
	}

	var row sloCountRow
	if err := e.conn.QueryRow(ctx, sloSQL(ind.Kind, ind.Service != nil), args...).ScanStruct(&row); err != nil {
		return sloCounts{}, fmt.Errorf("read slo %s counts: %w", ind.Kind, err)
	}
	return sloCounts{good: row.Good, total: row.Total}, nil
}
