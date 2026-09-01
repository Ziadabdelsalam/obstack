package alerting

// eval_trace.go — the trace leg (D481): one of two signals over
// `trace_summaries`, for the whole workspace or for one service.
//
// `trace_summaries` is an AggregatingMergeTree fed one partial row per inserted
// block, so the binding house rule (0003's own QUERY RULE, and
// `apps/web/src/server/queries/services.ts`'s error-trace read) applies here
// verbatim: GROUP BY workspace_id, trace_id with the matching combinator, never
// FINAL, never a bare SELECT. `max_seen_date` prunes cheaply in WHERE and the
// exact window bound is applied to the MERGED `min_start` in HAVING, where a
// trace's real start finally exists.
//
// Two semantics, stated here because they are choices and not derivations:
//
//   - error_rate_pct is ERROR SPANS over SPANS, times 100 — the house's one
//     definition of an error rate (services.ts states it on every surface that
//     renders it). It is computed from the summaries' own merged span_count and
//     error_count rather than from `spans`, because the packet binds this leg
//     to this table.
//
//   - p95_ms is the 95th percentile of TRACE duration (merged max_end minus
//     merged min_start), which is the only duration this table holds. It is NOT
//     the same number as services.ts's `p95_ms`, which is a percentile of SPAN
//     duration over `spans`. A trace is at least as long as its longest span,
//     so the alerting number is the larger of the two, and a rule author who
//     set a threshold by reading the service page would be alerted EARLIER than
//     they expected, not later. Called out in the T4 report rather than quietly
//     reconciled.
//
// The service filter selects traces that INVOLVE the service, which is what a
// trace-grained table can answer — a trace touching checkout and billing counts
// its billing spans toward checkout's rate. services.ts's recent-error-traces
// read carries the same caveat for the same reason, and states it in the UI.

import (
	"context"
	"fmt"
)

// traceRow is the one row the trace leg's SQL returns.
type traceRow struct {
	ErrorSpans float64 `ch:"error_spans"`
	TotalSpans float64 `ch:"total_spans"`
	P95Ms      float64 `ch:"p95_ms"`
	TraceCount uint64  `ch:"trace_count"`
}

// traceSQL builds the read. `filtered` adds the service predicate; the service
// name itself is bound, never spliced (D11).
func traceSQL(filtered bool) string {
	serviceClause := ""
	if filtered {
		// `services` is a groupUniqArrayArray SimpleAggregateFunction, so the
		// merged set only exists inside the aggregate — the services.ts idiom.
		serviceClause = "\n       AND has(groupUniqArrayArray(services), ?)"
	}
	return `
SELECT
    toFloat64(sum(error_spans)) AS error_spans,
    toFloat64(sum(total_spans)) AS total_spans,
    quantile(0.95)(duration_ms) AS p95_ms,
    count()                     AS trace_count
FROM (
    SELECT
        trace_id,
        sum(error_count) AS error_spans,
        sum(span_count)  AS total_spans,
        (toUnixTimestamp64Nano(max(max_end)) - toUnixTimestamp64Nano(min(min_start))) / 1e6 AS duration_ms
    FROM obstack.trace_summaries
    WHERE workspace_id = ?
      AND max_seen_date >= toDate(now('UTC') - toIntervalSecond(?))
    GROUP BY workspace_id, trace_id
    HAVING min(min_start) >= now() - toIntervalSecond(?)` + serviceClause + `
)`
}

// evalTrace runs the trace leg and reduces the row to the named signal.
func (e *Evaluator) evalTrace(ctx context.Context, workspaceID string, c Condition) (observation, error) {
	window, err := windowSeconds(c.Window)
	if err != nil {
		return observation{}, err
	}

	// The window is bound twice — once as the cheap max_seen_date partition
	// prune, once as the exact bound on the merged start — and the service, if
	// any, third.
	args := []any{workspaceID, window, window}
	if c.Service != nil {
		args = append(args, *c.Service)
	}

	var row traceRow
	if err := e.conn.QueryRow(ctx, traceSQL(c.Service != nil), args...).ScanStruct(&row); err != nil {
		return observation{}, fmt.Errorf("evaluate trace signal %q: %w", c.Signal, err)
	}

	// No trace matched: the window is empty. The aggregate above still returned
	// one row of zeros, and reading that as a rate of 0% or a p95 of 0ms is
	// exactly the D13 lie this gate exists to refuse.
	if row.TraceCount == 0 {
		return observation{}, nil
	}

	switch c.Signal {
	case "error_rate_pct":
		if row.TotalSpans <= 0 {
			// Traces with no spans is not a shape the MV can produce; if it
			// ever were, a rate with no denominator is a gap, not a zero.
			return observation{unit: "%"}, nil
		}
		return observation{value: row.ErrorSpans / row.TotalSpans * 100, unit: "%", hasData: true}, nil
	case "p95_ms":
		return observation{value: row.P95Ms, unit: "ms", hasData: true}, nil
	default:
		// Unreachable: ParseCondition admits exactly the two signals above.
		return observation{}, fmt.Errorf("%w: unknown trace signal %q", ErrInvalidCondition, c.Signal)
	}
}
