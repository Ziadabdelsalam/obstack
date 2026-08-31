// Metric mapping (D363 packet §1, amended D375–D378). This file turns a
// decoded OTLP metrics payload into obstack.metric_points rows, per the D363
// DDL packet's binding design (implemented verbatim; deviations escalate to
// the advisor).
//
// # Series identity (D8, packet §1, amended D375/D378)
//
// A series is identified by (name, series_hash) where
//
//	series_hash = sipHash64(name ‖ type ‖ service ‖ sorted KVs of
//	              mapUpdate(resource_attrs, point_attrs))
//
// computed here, at ingest, never at query time. D375: the hash is OTLP
// stream identity, so the FULL attribute picture feeds it — resource
// attributes merged with the point's own, point attributes winning any key
// collision (mapUpdate(map1, map2): map2 overrides map1 for shared keys,
// exactly mirroring ClickHouse's mapUpdate so the Go and SQL sides of the
// merged label set agree by construction). workspace_id still does not need
// to be baked in — it is already a leading ORDER BY column. D378: type joins
// the hash too, so a name emitted as both a gauge and a sum (dual emission)
// is honestly two series, never a silent merge.
//
// The RAW table still stores attributes and resource_attributes as two
// separate maps (OTLP fidelity, D375) — the merge above exists only to
// compute the hash, never the stored columns.
//
// # Delta normalization (D363 packet §1)
//
// Every row obstack stores is DELTA. Gauges pass through untouched — a gauge
// has no "since last report" to normalize. Cumulative sums and cumulative
// histograms convert through the per-series SeriesCache below, keyed on the
// previous value (or bucket snapshot) plus start_time:
//
//   - a series' first observation registers the series in the cache and
//     emits NO row — there is nothing to take a delta against yet;
//   - a reset — the new value less than the previous one, or start_time has
//     changed (the SDK restarted and its counter began again from zero) —
//     emits the current raw value(s) AS the delta, because that is the only
//     amount attributable to the window that just closed;
//   - otherwise the delta is current minus previous, elementwise for a
//     histogram's bucket_counts.
//
// Delta-temporality sums and histograms already carry a per-window value —
// they pass through unchanged, same as gauges, but their series still touches
// the cache so the active-series count (below) sees them.
//
// h_min/h_max are never delta'd (there is no subtraction that turns two
// extrema into a third one that means anything) — they pass through the raw
// data point's Min()/Max(), which the 1m rollup then reduces with its own
// min()/max() aggregate combinators.
//
// # Cardinality and admission (D363 packet §2, amended D376)
//
// The delta-conversion cache already keys every point by (workspace, series),
// so it is also the per-workspace active-series count that gates the
// 25,000-series cap — free, because every code path below registers its
// series regardless of temperament. D376: admission happens INSIDE
// MetricRows, not downstream — a point on a series the cache does not yet
// know, arriving while the workspace is already at cap, is dropped whole and
// RETURNED as a cardinality-drop count. The consumer meters that count under
// ReasonCardinality/DropCardinality through receive's countDrop, which is the
// only place both drop surfaces (the Prometheus counter and the workspace's
// api_key_health.dropped_cardinality column, pg 0008) fire from one call site.
// Mapping cannot fire it itself: the health leg needs the API key identity,
// which this package never sees. (ReasonMapping is counted here rather than
// returned because it has no health column at all — no DropReason exists for
// it — so the Prometheus counter is its whole surface.)
// An established series is ALWAYS admitted, cap or no cap
// (deterministic, no flapping); a rejected series allocates NO cache entry
// (binding) — a workspace stuck at cap costs nothing beyond the cap itself.
//
// Boot reconciliation (T4's job, across process restarts) calls Seed with the
// hashes obstack.metric_series already considers active — those become
// established immediately, so the cap can never reject a series this process
// simply has not seen yet.
//
// A data point carrying more than maxPointAttrs attributes is dropped whole
// (ReasonMapping, not ReasonCardinality — the attribute limit and the series
// cap are different guards): a partial attribute set would corrupt the
// series identity it is meant to describe.
//
// # Activity window (D377, clock ruled D380)
//
// Every cache entry carries lastSeen, set/refreshed at admission with the
// CACHE'S clock — ingest wall-clock (SeriesCache.Now, server time.Now() in
// production), full stop (D380). The producer-supplied point timestamp never
// drives lastSeen, ActiveCount, the cap check, or reap: a cap whose clock the
// sender controls is not a cap — a backdated stream would otherwise buy
// itself an exemption from the very guard it is supposed to trip. This is
// deliberately NOT the same "last_seen" obstack.metric_series shows after the
// write — that stored column keeps the point's own timestamp (a fact about
// the data, D13/D379); the two serve different purposes and are allowed to
// disagree. Boot Seed still reads that stored column's hashes (unchanged),
// stamping them with the cache's own Now() when it loads them, same as any
// other admission.
//
// ActiveCount counts entries whose lastSeen falls within the current UTC
// day, matching packet §2's "active = last_seen within the current UTC day"
// exactly (including for the cap check itself: a series idle since
// yesterday, still resident, does not occupy today's cap even though it has
// not been evicted yet). Entries idle more than 24h are evicted — reaped
// once per MetricRows call for the workspace being processed, before
// admission is decided for that export's points — bounding memory to
// roughly a day's worth of activity per workspace rather than everything a
// workspace has ever emitted. Accepted cost, on record: a cumulative stream
// silent more than 24h of INGEST time re-enters as a first observation — one
// dropped delta point, same as any other process restart.
//
// # Scaling seam (packet §1, recorded not silent)
//
// SeriesCache state lives in one process's memory. Correctness — the delta
// math, the active-series count, and the activity window — assumes a single
// ingest replica, or workspace-sticky routing once there is more than one; a
// second replica seeing half of a series' points would each think they were
// seeing that series for the first time.
package mapping

import (
	"bytes"
	"encoding/binary"
	"math/bits"
	"slices"
	"sort"
	"sync"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
)

// Type values, matching the Enum8 in 0005_metrics.sql.
const (
	MetricTypeGauge     = "gauge"
	MetricTypeSum       = "sum"
	MetricTypeHistogram = "histogram"
)

// maxPointAttrs is the D363 §2 attribute-count guard.
const maxPointAttrs = 64

// MetricRow is one row of obstack.metric_points. Field order is the writer's
// business; this struct is addressed by name.
type MetricRow struct {
	WorkspaceID string
	Name        string
	Type        string // MetricTypeGauge | MetricTypeSum | MetricTypeHistogram
	Unit        string
	Service     string
	SeriesHash  uint64
	Timestamp   time.Time
	Value       float64 // gauge value | DELTA for sums | 0 for histograms
	IsMonotonic bool

	Bounds       []float64 // histograms only; len = len(BucketCounts) - 1
	BucketCounts []uint64  // histograms only; delta-normalized
	HSum         float64
	HCount       uint64
	HMin         float64
	HMax         float64

	Attributes         map[string]string
	ResourceAttributes map[string]string
}

// MetricRows maps a decoded metrics payload to obstack.metric_points rows,
// normalizing every sum/histogram to delta via cache (D363 packet §1) and
// enforcing the 25k-series cap at admission (D376). A data point that cannot
// be mapped is dropped and counted here (D6), same posture as
// SpanRows/LogRows — one bad point does not cost the rest of the export.
//
// cardinalityDrops is the number of points the cap rejected (D376). It is
// RETURNED rather than counted here because a cardinality drop has two
// surfaces — the Prometheus counter and the workspace's
// api_key_health.dropped_cardinality column — and the health one needs the API
// key identity this package never sees; the consumer fires both from receive's
// single countDrop call site.
func MetricRows(workspaceID string, md pmetric.Metrics, cache *SeriesCache) (rows []MetricRow, cardinalityDrops int) {
	cache.reap(workspaceID)
	rows = make([]MetricRow, 0, md.DataPointCount())
	for _, rm := range md.ResourceMetrics().All() {
		res := mapResource(rm.Resource().Attributes())
		for _, sm := range rm.ScopeMetrics().All() {
			for _, metric := range sm.Metrics().All() {
				var (
					mapped  []MetricRow
					dropped int
				)
				switch metric.Type() {
				case pmetric.MetricTypeGauge:
					mapped, dropped = gaugeRows(workspaceID, res, metric, cache)
				case pmetric.MetricTypeSum:
					mapped, dropped = sumRows(workspaceID, res, metric, cache)
				case pmetric.MetricTypeHistogram:
					mapped, dropped = histogramRows(workspaceID, res, metric, cache)
				default:
					dropUnsupported(workspaceID, metric)
				}
				rows = append(rows, mapped...)
				cardinalityDrops += dropped
			}
		}
	}
	return rows, cardinalityDrops
}

// dropUnsupported counts every data point of a metric type the D363 raw table
// has no column shape for. Gauge, sum and histogram are the whole contract
// (packet §1) — exponential histograms and summaries are OTLP types no
// obstack SDK emits and the table was never built for.
func dropUnsupported(workspaceID string, metric pmetric.Metric) {
	n := 0
	switch metric.Type() {
	case pmetric.MetricTypeExponentialHistogram:
		n = metric.ExponentialHistogram().DataPoints().Len()
	case pmetric.MetricTypeSummary:
		n = metric.Summary().DataPoints().Len()
	}
	for i := 0; i < n; i++ {
		metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonMapping).Inc()
	}
}

// baseRow builds the columns common to every point regardless of temperament:
// identity (series_hash, D375/D378), the promoted resource columns, and the
// point's own attribute Map. ok is false when the point carries more than
// maxPointAttrs attributes (D363 §2) — dropped whole and counted, because a
// partial attribute set would corrupt the series it belongs to.
func baseRow(workspaceID string, res resource, metric pmetric.Metric, mtype string, attrs pcommon.Map, ts pcommon.Timestamp) (row MetricRow, hash uint64, ok bool) {
	if attrs.Len() > maxPointAttrs {
		metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonMapping).Inc()
		return MetricRow{}, 0, false
	}
	pointAttrs := flattenAttributes(attrs)
	hash = seriesHash(metric.Name(), mtype, res.service, res.attributes, pointAttrs)
	row = MetricRow{
		WorkspaceID:        workspaceID,
		Name:               metric.Name(),
		Type:               mtype,
		Unit:               metric.Unit(),
		Service:            res.service,
		SeriesHash:         hash,
		Timestamp:          ts.AsTime(),
		Attributes:         pointAttrs,
		ResourceAttributes: res.attributes,
	}
	return row, hash, true
}

// gaugeRows passes every point through untouched (a gauge has no "since last
// report" to normalize) — it still touches the cache so the series is
// admitted and counts toward the workspace's active-series total.
func gaugeRows(workspaceID string, res resource, metric pmetric.Metric, cache *SeriesCache) (rows []MetricRow, cardinalityDrops int) {
	dps := metric.Gauge().DataPoints()
	rows = make([]MetricRow, 0, dps.Len())
	for _, dp := range dps.All() {
		row, hash, ok := baseRow(workspaceID, res, metric, MetricTypeGauge, dp.Attributes(), dp.Timestamp())
		if !ok {
			continue
		}
		if !cache.touch(workspaceID, hash) {
			cardinalityDrops++
			continue
		}
		row.Value = numberValue(dp)
		rows = append(rows, row)
	}
	return rows, cardinalityDrops
}

// sumRows normalizes a cumulative sum to delta via the cache, or passes a
// delta sum through unchanged (packet §1).
func sumRows(workspaceID string, res resource, metric pmetric.Metric, cache *SeriesCache) (rows []MetricRow, cardinalityDrops int) {
	sum := metric.Sum()
	dps := sum.DataPoints()
	rows = make([]MetricRow, 0, dps.Len())
	cumulative := sum.AggregationTemporality() == pmetric.AggregationTemporalityCumulative
	for _, dp := range dps.All() {
		row, hash, ok := baseRow(workspaceID, res, metric, MetricTypeSum, dp.Attributes(), dp.Timestamp())
		if !ok {
			continue
		}
		row.IsMonotonic = sum.IsMonotonic()
		raw := numberValue(dp)

		if !cumulative {
			if !cache.touch(workspaceID, hash) {
				cardinalityDrops++
				continue
			}
			row.Value = raw
			rows = append(rows, row)
			continue
		}

		delta, emit, admitted := cache.deltaSum(workspaceID, hash, raw, dp.StartTimestamp().AsTime())
		if !admitted {
			cardinalityDrops++
			continue
		}
		if !emit {
			continue // first observation: registers the series, emits no row
		}
		row.Value = delta
		rows = append(rows, row)
	}
	return rows, cardinalityDrops
}

// histogramRows normalizes a cumulative histogram's bucket_counts/sum/count to
// delta via the cache (elementwise bucket subtraction), or passes a delta
// histogram through unchanged (packet §1). h_min/h_max are never delta'd —
// they carry the raw data point's extrema, reduced by the 1m rollup's own
// min()/max() combinators.
func histogramRows(workspaceID string, res resource, metric pmetric.Metric, cache *SeriesCache) (rows []MetricRow, cardinalityDrops int) {
	hist := metric.Histogram()
	dps := hist.DataPoints()
	rows = make([]MetricRow, 0, dps.Len())
	cumulative := hist.AggregationTemporality() == pmetric.AggregationTemporalityCumulative
	for _, dp := range dps.All() {
		row, hash, ok := baseRow(workspaceID, res, metric, MetricTypeHistogram, dp.Attributes(), dp.Timestamp())
		if !ok {
			continue
		}
		row.Bounds = dp.ExplicitBounds().AsRaw()
		if dp.HasMin() {
			row.HMin = dp.Min()
		}
		if dp.HasMax() {
			row.HMax = dp.Max()
		}
		rawCounts := dp.BucketCounts().AsRaw()
		rawSum := dp.Sum()
		rawCount := dp.Count()

		if !cumulative {
			if !cache.touch(workspaceID, hash) {
				cardinalityDrops++
				continue
			}
			row.BucketCounts = rawCounts
			row.HSum = rawSum
			row.HCount = rawCount
			rows = append(rows, row)
			continue
		}

		counts, hsum, hcount, emit, admitted := cache.deltaHistogram(workspaceID, hash, dp.StartTimestamp().AsTime(), rawCounts, rawSum, rawCount)
		if !admitted {
			cardinalityDrops++
			continue
		}
		if !emit {
			continue // first observation: registers the series, emits no row
		}
		row.BucketCounts = counts
		row.HSum = hsum
		row.HCount = hcount
		rows = append(rows, row)
	}
	return rows, cardinalityDrops
}

// numberValue reads a NumberDataPoint's value regardless of which of the two
// OTLP wire representations it arrived in.
func numberValue(dp pmetric.NumberDataPoint) float64 {
	switch dp.ValueType() {
	case pmetric.NumberDataPointValueTypeDouble:
		return dp.DoubleValue()
	case pmetric.NumberDataPointValueTypeInt:
		return float64(dp.IntValue())
	default:
		return 0
	}
}

// SeriesCache holds the per-process, per-series state that makes
// cumulative-to-delta normalization possible (D363 packet §1) and is where
// the 25k-series cap is admitted (D376). See the package doc's "Cardinality
// and admission" and "Activity window" sections for the full contract.
type SeriesCache struct {
	mu   sync.Mutex
	cap  int
	byWS map[string]map[uint64]*seriesState

	// Now returns the current time. A field, not a direct time.Now() call, so
	// the D377 24h idle-eviction and current-UTC-day active window are
	// testable without waiting a day. NewSeriesCache sets it to time.Now;
	// tests may override it.
	Now func() time.Time
}

// seriesState is the previous cumulative snapshot for one series, plus its
// D377 activity clock. Only the fields for the series' own type are ever
// populated — type is constant per series (packet §1) — the rest sit at
// their zero value, unused.
type seriesState struct {
	lastSeen time.Time // D380: the cache's ingest wall-clock, never the point's own timestamp

	// hasBaseline is false until a cumulative point has stored its snapshot
	// below. Admission (established vs new) and having a delta baseline are
	// different things: a Seed'ed entry is established for the cap yet holds
	// no snapshot, and subtracting against its zero value would emit the
	// series' whole lifetime total as one delta on the first point after a
	// restart.
	hasBaseline bool
	startTime   time.Time

	value float64 // cumulative sum

	bucketCounts []uint64 // cumulative histogram
	hSum         float64
	hCount       uint64
}

// NewSeriesCache returns an empty, ready-to-use cache admitting at most cap
// active series per workspace (D376). One instance is shared for the ingest
// process's lifetime.
func NewSeriesCache(cap int) *SeriesCache {
	return &SeriesCache{
		cap:  cap,
		byWS: make(map[string]map[uint64]*seriesState),
		Now:  time.Now,
	}
}

// ActiveCount returns the number of series observed for workspaceID whose
// lastSeen falls within the current UTC day (packet §2's definition of
// "active", exactly) — the same number the 25k cap is admitted against.
func (c *SeriesCache) ActiveCount(workspaceID string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.activeCountLocked(workspaceID)
}

func (c *SeriesCache) activeCountLocked(workspaceID string) int {
	today := startOfUTCDay(c.Now())
	n := 0
	for _, st := range c.byWS[workspaceID] {
		if !st.lastSeen.Before(today) {
			n++
		}
	}
	return n
}

func startOfUTCDay(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// reap drops entries idle more than 24h (D377) so an abandoned series' slot
// frees up rather than permanently occupying the cap. Called once per
// MetricRows export for the workspace being processed, before admission is
// decided for any of that export's points.
func (c *SeriesCache) reap(workspaceID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ws := c.byWS[workspaceID]
	if ws == nil {
		return
	}
	cutoff := c.Now().Add(-24 * time.Hour)
	for hash, st := range ws {
		if st.lastSeen.Before(cutoff) {
			delete(ws, hash)
		}
	}
}

// Seed loads a workspace's already-established series into the cache — T4's
// boot reconciliation from obstack.metric_series (packet §2: the hashes with
// last_seen >= today). Seeded hashes become established immediately: D376's
// cap can never reject a series that predates this process, and they count
// toward ActiveCount right away. A hash already present is left alone.
//
// A seeded entry carries NO cumulative baseline (metric_series stores identity,
// not the last cumulative snapshot), so the first cumulative point after a
// restart still registers a baseline and emits no row — the ordinary
// first-observation cost D377 already records, rather than a delta the size of
// the counter's entire lifetime.
func (c *SeriesCache) Seed(workspaceID string, hashes []uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ws := c.byWS[workspaceID]
	if ws == nil {
		ws = make(map[uint64]*seriesState)
		c.byWS[workspaceID] = ws
	}
	now := c.Now()
	for _, h := range hashes {
		if _, ok := ws[h]; ok {
			continue
		}
		ws[h] = &seriesState{lastSeen: now}
	}
}

// admitLocked implements D376: an established series (already in the cache)
// is always admitted, cap or no cap, and has its lastSeen refreshed to the
// cache's ingest wall-clock (c.Now(), D380 — never a caller-supplied time); a
// series with no entry yet is admitted only while the workspace's active
// count is under cap — and if rejected, allocates NO entry (binding). Must be
// called with c.mu held.
func (c *SeriesCache) admitLocked(workspaceID string, seriesHash uint64) (st *seriesState, isNew, admitted bool) {
	ws := c.byWS[workspaceID]
	if ws == nil {
		ws = make(map[uint64]*seriesState)
		c.byWS[workspaceID] = ws
	}
	seen := c.Now()
	if st, ok := ws[seriesHash]; ok {
		st.lastSeen = seen
		return st, false, true
	}
	if c.activeCountLocked(workspaceID) >= c.cap {
		return nil, false, false
	}
	st = &seriesState{lastSeen: seen}
	ws[seriesHash] = st
	return st, true, true
}

// touch admits seriesHash for workspaceID (D376) if it is not yet known, or
// refreshes an established one's lastSeen. Used by gauges and
// delta-temporality sums/histograms, which have no cumulative state to track
// but still need admission and the active-series count.
func (c *SeriesCache) touch(workspaceID string, seriesHash uint64) (admitted bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, _, admitted = c.admitLocked(workspaceID, seriesHash)
	return admitted
}

// deltaSum is the D363 §1 reset rule for a cumulative sum, expressed as one
// locked read-modify-write so two points for the same series can never
// interleave. admitted is false only when D376's cap rejected the point (a
// brand-new series arriving at cap) — in which case emit is meaningless.
// emit is false only on the series' first observation.
func (c *SeriesCache) deltaSum(workspaceID string, seriesHash uint64, value float64, startTime time.Time) (delta float64, emit, admitted bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	st, isNew, admitted := c.admitLocked(workspaceID, seriesHash)
	if !admitted {
		return 0, false, false
	}
	if isNew || !st.hasBaseline {
		st.hasBaseline = true
		st.startTime = startTime
		st.value = value
		return 0, false, true // first observation: baseline registered, no row
	}

	if startTime != st.startTime || value < st.value {
		delta = value // reset: the raw value IS the delta (packet §1)
	} else {
		delta = value - st.value
	}
	st.startTime = startTime
	st.value = value
	return delta, true, true
}

// deltaHistogram is deltaSum's counterpart for a cumulative histogram:
// bucket_counts subtract elementwise, h_sum/h_count subtract as scalars.
// admitted is false only when D376's cap rejected the point. emit is false
// only on the series' first observation.
func (c *SeriesCache) deltaHistogram(workspaceID string, seriesHash uint64, startTime time.Time, counts []uint64, sum float64, count uint64) (deltaCounts []uint64, deltaSum float64, deltaCount uint64, emit, admitted bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	st, isNew, admitted := c.admitLocked(workspaceID, seriesHash)
	if !admitted {
		return nil, 0, 0, false, false
	}
	if isNew || !st.hasBaseline {
		st.hasBaseline = true
		st.startTime = startTime
		st.bucketCounts = slices.Clone(counts)
		st.hSum = sum
		st.hCount = count
		return nil, 0, 0, false, true // first observation: baseline registered, no row
	}

	if startTime != st.startTime || count < st.hCount || anyBucketReset(counts, st.bucketCounts) {
		// reset: the raw snapshot IS the delta (packet §1), applied per field.
		deltaCounts, deltaSum, deltaCount = slices.Clone(counts), sum, count
	} else {
		deltaCounts = subtractCounts(counts, st.bucketCounts)
		deltaSum = sum - st.hSum
		deltaCount = count - st.hCount
	}
	st.startTime = startTime
	st.bucketCounts = slices.Clone(counts)
	st.hSum = sum
	st.hCount = count
	return deltaCounts, deltaSum, deltaCount, true, true
}

// anyBucketReset reports whether the current bucket_counts cannot be a
// monotonic continuation of the previous snapshot — either the bucket
// boundaries themselves changed (a different bounds length) or some bucket
// went backwards.
func anyBucketReset(cur, prev []uint64) bool {
	if len(cur) != len(prev) {
		return true
	}
	for i := range cur {
		if cur[i] < prev[i] {
			return true
		}
	}
	return false
}

func subtractCounts(cur, prev []uint64) []uint64 {
	out := make([]uint64, len(cur))
	for i := range cur {
		out[i] = cur[i] - prev[i]
	}
	return out
}

// mergeAttrs implements D375's mapUpdate(resource_attrs, point_attrs):
// resource attributes are the base, point attributes win on key collision —
// mirroring ClickHouse's mapUpdate(map1, map2) semantics exactly (map2
// overrides map1), so the Go and SQL sides of the identity agree by
// construction.
func mergeAttrs(resourceAttrs, pointAttrs map[string]string) map[string]string {
	merged := make(map[string]string, len(resourceAttrs)+len(pointAttrs))
	for k, v := range resourceAttrs {
		merged[k] = v
	}
	for k, v := range pointAttrs {
		merged[k] = v
	}
	return merged
}

// seriesHash implements the D363 §1 series identity, amended D375/D378:
// sipHash64 over the metric name, its type, its service, and the sorted KVs
// of mapUpdate(resourceAttrs, pointAttrs) — never workspace_id (already a
// leading ORDER BY column). Fields are length-prefixed so no concatenation of
// two different (name, type, service, attrs) tuples can produce the same
// bytes.
func seriesHash(name, mtype, service string, resourceAttrs, pointAttrs map[string]string) uint64 {
	merged := mergeAttrs(resourceAttrs, pointAttrs)
	keys := make([]string, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var buf bytes.Buffer
	writeField(&buf, name)
	writeField(&buf, mtype)
	writeField(&buf, service)
	for _, k := range keys {
		writeField(&buf, k)
		writeField(&buf, merged[k])
	}
	return sipHash64(0, 0, buf.Bytes())
}

func writeField(buf *bytes.Buffer, s string) {
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(s)))
	buf.Write(lenBuf[:])
	buf.WriteString(s)
}

// sipHash64 is SipHash-2-4 (Aumasson & Bernstein), 64-bit output. obstack has
// no cross-process or cross-language contract on this value — D8: computed
// once, at ingest, and never recomputed anywhere else, including ClickHouse —
// so a fixed zero key is deliberate: series_hash only has to be stable and
// well distributed across this function's own calls, not portable to another
// implementation of "sipHash64".
func sipHash64(k0, k1 uint64, data []byte) uint64 {
	v0 := k0 ^ 0x736f6d6570736575
	v1 := k1 ^ 0x646f72616e646f6d
	v2 := k0 ^ 0x6c7967656e657261
	v3 := k1 ^ 0x7465646279746573

	round := func() {
		v0 += v1
		v1 = bits.RotateLeft64(v1, 13)
		v1 ^= v0
		v0 = bits.RotateLeft64(v0, 32)
		v2 += v3
		v3 = bits.RotateLeft64(v3, 16)
		v3 ^= v2
		v0 += v3
		v3 = bits.RotateLeft64(v3, 21)
		v3 ^= v0
		v2 += v1
		v1 = bits.RotateLeft64(v1, 17)
		v1 ^= v2
		v2 = bits.RotateLeft64(v2, 32)
	}

	n := len(data)
	end := n - n%8
	for i := 0; i < end; i += 8 {
		m := binary.LittleEndian.Uint64(data[i : i+8])
		v3 ^= m
		round()
		round()
		v0 ^= m
	}

	last := uint64(n) << 56
	for i, b := range data[end:] {
		last |= uint64(b) << (8 * uint(i))
	}
	v3 ^= last
	round()
	round()
	v0 ^= last

	v2 ^= 0xff
	round()
	round()
	round()
	round()

	return v0 ^ v1 ^ v2 ^ v3
}
