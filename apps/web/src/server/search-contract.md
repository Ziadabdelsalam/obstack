# The traces-list search contract (D44 / D45 / D50)

One contract, two implementations, written down exactly once — here. Both cite
this file and a fork between them is the parity bug T1 exists to close (D13):

- **live**: `queries/traces.ts` — `queryTraceSearch` and its SQL builders
- **mock**: `data.ts` — `mockMatches` / `mockSearchTraces`

## Free text (D45)

- **Terms**: the query is whitespace-split into terms (`splitSearchTerms` —
  both implementations tokenize through that one function); an empty query is
  no free-text constraint.
- **Matching**: case-insensitive substring. A term matches a trace if ANY field
  in the trace's reach set contains it; **AND across terms** — every term must
  match, each on any field independently.
- **Reach set**: summary fields (root name, trace id, models, services) ∪ span
  `name` ∪ span `prompt`/`completion` ∪ log `body` ∪ log `prompt`/`completion`
  — **trace-carrying rows only** (`trace_id != ''`). Trace-less logs are
  unreachable from the traces list by construction; they belong to `/app/logs`
  search, where D42 carrier rows are additionally excluded from render, count
  AND match (D51 — that exclusion is documented at the logs query site).
- **D42 content-carrier rows ARE in the reach** (D45): D42(d) is a *display*
  rule — bodyless carriers never render as rail rows — but the carrier row is
  where event-form prompt content physically lives, and the UI displays that
  content folded into `LlmDetail`, so search must find it. Excluding carriers
  would make every event-form trace unfindable by its own visible prompt.
- **Row source vs reach** (PRD §7:94 / §8:115 as amended by D45): list rows,
  totals and every structured filter come from `trace_summaries` alone. The
  span/log legs are trace-id **semi-joins** that return ids, never rows —
  "never scans spans" means "never builds list rows from spans".
- **Mock mapping of the reach**: `Trace.rootName`/`id`/`models`/`services` ∪
  `spans[].name` ∪ `spans[].llm.prompt`/`.completion` ∪ trace-carrying
  `logs[].body`. The mock data model has no separate carrier rows — event-form
  content already lives on `llm`, which is exactly where the live read folds it
  (D42(d)) — so the two reaches are equivalent.
- **Case folding (D56)**: case-insensitivity is **Unicode simple case
  folding** in both modes — live via ClickHouse `positionCaseInsensitiveUTF8`
  in every free-text predicate, mock via JS `toLowerCase` — so `café` finds
  `CAFÉ` identically in both (probed live+mock in the integration parity
  suite). One agreed BOTH-mode limitation: locale-dependent mappings such as
  the Turkish dotted İ do not fold (`istanbul` matches `İSTANBUL` in neither
  mode); simple folding, not locale folding, is the contract. Caveat: on
  invalid UTF-8 input ClickHouse's UTF8 functions have undefined match
  behavior (no crash); OTLP strings are protobuf-UTF-8, so valid input is the
  ingest contract.

## Structured filters (PRD §8, server-side in both modes)

`service` (exact membership in the trace's services), `status` (ok/error/all),
duration (`minMs`), `model` (exact membership in models), cost range
(`minCostUsd`/`maxCostUsd`; max absent or negative = unbounded), time range
(below). Never re-filtered client-side (D13) — one predicate, applied where the
data lives.

## Time bound (D50)

- Every traces-list query carries an **explicit time bound**: trace start
  (`min(min_start)` live, `startedAt` mock) within the last `rangeMs`, default
  6 hours (`DEFAULT_TRACE_RANGE_MS` — the one product-wide default, matching
  `getOverview`'s default range and the shipped header copy).
- **Reference clock per mode**: the query's execution time in live mode; the
  mock clock `NOW` (`mock/generate.ts`) in mock mode — mock traces are
  generated inside ~6h behind `NOW`, so a wall-clock reference would empty
  every mock surface (F6/F7).
- The reference clock is sampled **once per request** and bound into both the
  page and the count query, so the two always evaluate the same predicate.

## Totals, order, pages (D44)

- Offset/limit pages of `TRACE_PAGE_SIZE` rows; the page number is 1-based and
  lives in the URL.
- The total is the **exact FILTERED total**: a count over the same grouped,
  filtered predicate the page uses (`SELECT count() FROM (<grouped, filtered
  subquery>)` live; `matched.length` mock) — never the page length, never an
  unfiltered read.
- **Deterministic order**: trace start descending, then trace id ascending as
  the mandatory tie-break — offset paging over a tie-unstable sort returns
  overlapping pages after a merge. Mock compares ids by codepoint to match
  ClickHouse `String` order.
