// Package receive serves the two OTLP transports (D3): gRPC on :4317 and HTTP
// on :4318 at /v1/traces and /v1/logs, in application/x-protobuf and
// application/json. Both transports authenticate with the D4 bearer keys, share
// one decode path, and answer per the D6 error posture — a payload that cannot
// be unmarshalled is one 4xx and one counted drop, never a 5xx that would put
// an exporter into a retry loop.
//
// The shared path is also where a workspace over its plan's quota degrades to
// head sampling (D165). Degradation is deliberately not a refusal: an
// over-quota workspace keeps getting 200s and keeps seeing a tenth of its
// traffic, whole traces at a time, because a hard cut-off would make the
// product go dark exactly when someone is trying to work out why it is busy.
// What it costs is counted, in Prometheus for operators and in the per-key
// health rows the product shows.
package receive

import (
	"context"
	"fmt"
	"hash/fnv"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
	"google.golang.org/grpc"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/changes"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metering"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
)

// Consumer takes decoded, authenticated telemetry off the wire. It cannot fail
// the request: per D23 the OTLP response acknowledges enqueue, not the
// ClickHouse write, so a consumer that later loses the batch counts a drop with
// reason "write" instead of turning it into an exporter error.
type Consumer interface {
	ConsumeTraces(ctx context.Context, workspaceID string, td ptrace.Traces)
	ConsumeLogs(ctx context.Context, workspaceID string, ld plog.Logs)

	// ConsumeMetrics maps and enqueues a decoded metrics export, admitting new
	// series against the D376 cardinality cap along the way (mapping.MetricRows
	// decides; this call never does). cardinalityDrops is handed back rather
	// than counted on the far side of the interface because the health-column
	// half of that drop (api_key_health.dropped_cardinality) needs the API key
	// identity, which the writer never sees — countDrop below is the one call
	// site with both halves.
	ConsumeMetrics(ctx context.Context, workspaceID string, md pmetric.Metrics) (cardinalityDrops int)
}

// Meter accumulates what each key carried in and what was refused, for the
// Postgres rows the product reads (D166): the usage ledger the billing tab and
// the banner raise from, and the per-key health rows that carry the workspace's
// ingest-error count. Those rows are the product surface; the Prometheus
// counters beside them are ops-only and the two are never reconciled.
//
// A nil Meter meters nothing. Nothing on this path depends on it — an export is
// never held up, failed or reordered by metering — so a receiver built without
// one still serves telemetry exactly as it otherwise would.
type Meter interface {
	RecordAccepted(workspaceID, keyID string, spans, logs int64)
	// RecordAcceptedMetrics is RecordAccepted's counterpart for metric points
	// (D368): health.accepted + lastEventAt only, never the usage ledger —
	// metrics ingestion writes zero usage_ledger rows and never consults the
	// quota decision (D365).
	RecordAcceptedMetrics(workspaceID, keyID string, points int64)
	// RecordAcceptedChange is the change-event counterpart (D497): one
	// accepted event is one on the key's health.accepted and its last event —
	// the RecordAcceptedMetrics posture, never the ledger, never a quota input.
	RecordAcceptedChange(workspaceID, keyID string)
	RecordDropped(workspaceID, keyID string, reason metering.DropReason, records int64)
}

// maxRequestBytes caps a single OTLP payload. Exporters batch well below this;
// the limit exists so an unbounded body cannot exhaust the process.
const maxRequestBytes = 16 << 20

// Config describes one receiver pair.
type Config struct {
	GRPCAddr string
	HTTPAddr string
	Auth     auth.Authenticator
	Consumer Consumer

	// OverQuota reports whether a workspace has crossed its plan's quota, as of
	// the workspace-state cache's last refresh (D163/D164). It is a cache read
	// and must never block: the consume path asking Postgres per export would
	// make the control plane a dependency of the data path. Nil — and the
	// cache's own answer for a workspace it has never read — means not over
	// quota, so our outage cannot start sampling a paying customer's traces
	// away (D164d).
	OverQuota func(workspaceID string) bool

	// Meter is where accepted and dropped records are accumulated for the
	// Postgres rows. Nil meters nothing; see Meter.
	Meter Meter

	// VercelDrainSecret turns on the drain route's `x-vercel-signature` check
	// (D287). Empty leaves the bearer key as that route's only credential,
	// which is what every other route on this mux runs with. It arrives here
	// resolved rather than being read from the environment inside the handler,
	// so which posture the process is in is decided once, at boot, where it can
	// be stated.
	VercelDrainSecret string

	// Changes is where POST /v1/changes writes (S7.2 packet, D493/D495): a
	// synchronous, workspace-scoped insert whose outcome IS the response. Nil
	// leaves the route unregistered — a receiver built without a store has no
	// honest answer to give it.
	Changes changes.Store

	// Rand draws the sampling verdict for a log record that carries no trace id
	// — the one record class with no trace to be whole with. Nil uses the
	// process's own source; tests inject a deterministic one. Whatever is here
	// is called from every serving goroutine, so it must be safe for concurrent
	// use.
	Rand func() uint64
}

// Server owns both OTLP listeners.
type Server struct {
	cfg Config

	grpc *grpc.Server
	http *http.Server

	grpcLn net.Listener
	httpLn net.Listener

	// changeLimiter is the per-workspace cap on /v1/changes (D498), owned here
	// because it is per process: N replicas hold N buckets, stated in the packet.
	changeLimiter *changes.Limiter

	errs chan error
}

// New builds the receivers. Nothing is bound until Start.
func New(cfg Config) *Server {
	s := &Server{cfg: cfg, errs: make(chan error, 2), changeLimiter: changes.NewLimiter()}
	s.grpc = s.newGRPCServer()
	s.http = &http.Server{
		Handler:           s.httpHandler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	return s
}

// Start binds both listeners and serves in the background. It returns once the
// ports are bound, so a caller that gets a nil error knows the service is
// reachable; serving failures arrive on Err.
func (s *Server) Start() error {
	grpcLn, err := net.Listen("tcp", s.cfg.GRPCAddr)
	if err != nil {
		return fmt.Errorf("otlp grpc listen %s: %w", s.cfg.GRPCAddr, err)
	}
	httpLn, err := net.Listen("tcp", s.cfg.HTTPAddr)
	if err != nil {
		grpcLn.Close()
		return fmt.Errorf("otlp http listen %s: %w", s.cfg.HTTPAddr, err)
	}
	s.grpcLn, s.httpLn = grpcLn, httpLn

	go func() {
		slog.Info("otlp grpc listening", "addr", s.GRPCAddr())
		if err := s.grpc.Serve(grpcLn); err != nil {
			s.errs <- fmt.Errorf("otlp grpc server: %w", err)
		}
	}()
	go func() {
		slog.Info("otlp http listening", "addr", s.HTTPAddr())
		if err := s.http.Serve(httpLn); err != nil && err != http.ErrServerClosed {
			s.errs <- fmt.Errorf("otlp http server: %w", err)
		}
	}()
	return nil
}

// Err reports a listener that died on its own.
func (s *Server) Err() <-chan error { return s.errs }

// GRPCAddr is the bound gRPC address — the resolved one, so a Config asking for
// port 0 is still addressable.
func (s *Server) GRPCAddr() string { return addrOf(s.grpcLn) }

// HTTPAddr is the bound HTTP address.
func (s *Server) HTTPAddr() string { return addrOf(s.httpLn) }

// Shutdown drains in-flight exports on both transports.
func (s *Server) Shutdown(ctx context.Context) error {
	stopped := make(chan struct{})
	go func() {
		s.grpc.GracefulStop()
		close(stopped)
	}()

	err := s.http.Shutdown(ctx)
	select {
	case <-stopped:
	case <-ctx.Done():
		s.grpc.Stop()
	}
	return err
}

func addrOf(ln net.Listener) string {
	if ln == nil {
		return ""
	}
	return ln.Addr().String()
}

// consumeTraces sheds what quota says to shed, hands the rest on, and counts
// what was accepted. Counting happens here, after auth and decode, because that
// is exactly the point where the service takes responsibility for the records
// (D23).
//
// The workspace arrives as an argument because that is what the Consumer seam
// is keyed on; the key id comes off the context, where both transports put the
// resolved identity at their auth step. The health rows are per key (D100) and
// there is nothing else on this path to attribute a record to.
func (s *Server) consumeTraces(ctx context.Context, workspaceID string, req ptraceotlp.ExportRequest) {
	identity := auth.Identity{WorkspaceID: workspaceID, KeyID: auth.IdentityFromContext(ctx).KeyID}
	td := req.Traces()

	if s.overQuota(workspaceID) {
		s.countDrop(identity, dropQuota, s.sampleTraces(td))
	}

	accepted := td.SpanCount()
	if accepted == 0 {
		// Either an empty export or one sampled away whole. Handing an empty
		// batch on would enqueue nothing and counting zero would put a series on
		// /metrics saying a workspace sent something it did not.
		return
	}
	s.cfg.Consumer.ConsumeTraces(ctx, workspaceID, td)
	metrics.Accepted.WithLabelValues(workspaceID, metrics.SignalTraces).Add(float64(accepted))
	s.meterAccepted(identity, int64(accepted), 0)
}

func (s *Server) consumeLogs(ctx context.Context, workspaceID string, req plogotlp.ExportRequest) {
	identity := auth.Identity{WorkspaceID: workspaceID, KeyID: auth.IdentityFromContext(ctx).KeyID}
	ld := req.Logs()

	if s.overQuota(workspaceID) {
		s.countDrop(identity, dropQuota, s.sampleLogs(ld))
	}

	accepted := ld.LogRecordCount()
	if accepted == 0 {
		return
	}
	s.cfg.Consumer.ConsumeLogs(ctx, workspaceID, ld)
	metrics.Accepted.WithLabelValues(workspaceID, metrics.SignalLogs).Add(float64(accepted))
	s.meterAccepted(identity, 0, int64(accepted))
}

// consumeMetrics is traces/logs' counterpart for the metrics signal, with one
// deliberate omission: it never calls overQuota (D365/D368) — metrics carry no
// quota and ReasonQuota cannot fire on this path, full stop. What it does
// instead of quota sampling is meter the cardinality-cap drop the Consumer
// hands back: admission itself lives in mapping (T2's SeriesCache), this
// method only plumbs the cache in via the Consumer and counts what it reports.
func (s *Server) consumeMetrics(ctx context.Context, workspaceID string, req pmetricotlp.ExportRequest) {
	identity := auth.Identity{WorkspaceID: workspaceID, KeyID: auth.IdentityFromContext(ctx).KeyID}
	md := req.Metrics()

	accepted := md.DataPointCount()
	if accepted == 0 {
		return
	}
	cardinalityDrops := s.cfg.Consumer.ConsumeMetrics(ctx, workspaceID, md)
	s.countDrop(identity, dropCardinality, cardinalityDrops)
	metrics.Accepted.WithLabelValues(workspaceID, metrics.SignalMetrics).Add(float64(accepted))
	s.meterAcceptedMetrics(identity, int64(accepted))
}

// quotaSampleRate is head sampling's divisor while a workspace is over its
// plan's quota (D165): one trace in ten survives. One rate for every plan, no
// environment variable — a rate an operator can turn is a rate that differs
// between two replicas of the same service, and a trace whose spans landed on
// both would then be half there. The product's copy stays qualitative for the
// same reason the number lives here: it is ours to change, not a promise.
const quotaSampleRate = 10

// keepTrace is the D165 verdict, pinned across languages: FNV-1a 64 over the 16
// raw trace-id bytes, kept iff the hash is a multiple of quotaSampleRate.
//
// Seedless and stateless on purpose. Every replica, every export and every
// retry reaches the same answer about the same trace with nothing shared
// between them, which is the only reason "a sampled-out trace drops whole" can
// be true of a trace whose spans and logs arrive in separate requests. Pinned
// trace-id vectors are asserted in this package's suite and re-asserted by the
// e2e drive; amending this function sweeps both in the same round.
func keepTrace(traceID pcommon.TraceID) bool {
	h := fnv.New64a()
	h.Write(traceID[:])
	return h.Sum64()%quotaSampleRate == 0
}

// sampleTraces drops every span of every sampled-out trace and reports how many
// records went. Scope and resource groups left empty go with them: an export of
// empty groups is not telemetry, and the writer would map nothing out of it.
//
// A span with no trace id has nothing to be whole with, so it draws for itself
// at the same rate (D165) through keepRecord — the same branch trace-less log
// records take. Routing it through keepTrace instead would hash sixteen zero
// bytes to one fixed verdict and shed the whole trace-less class at 100%.
func (s *Server) sampleTraces(td ptrace.Traces) int {
	dropped := 0
	td.ResourceSpans().RemoveIf(func(rs ptrace.ResourceSpans) bool {
		rs.ScopeSpans().RemoveIf(func(ss ptrace.ScopeSpans) bool {
			ss.Spans().RemoveIf(func(span ptrace.Span) bool {
				if s.keepRecord(span.TraceID()) {
					return false
				}
				dropped++
				return true
			})
			return ss.Spans().Len() == 0
		})
		return rs.ScopeSpans().Len() == 0
	})
	return dropped
}

// sampleLogs applies the trace's verdict to every record that carries a trace
// id, so a dropped trace loses its logs along with its spans and a surviving
// one keeps the correlated whole. A record with no trace id has nothing to be
// whole with, so it draws for itself at the same rate (D165).
func (s *Server) sampleLogs(ld plog.Logs) int {
	dropped := 0
	ld.ResourceLogs().RemoveIf(func(rl plog.ResourceLogs) bool {
		rl.ScopeLogs().RemoveIf(func(sl plog.ScopeLogs) bool {
			sl.LogRecords().RemoveIf(func(record plog.LogRecord) bool {
				if s.keepRecord(record.TraceID()) {
					return false
				}
				dropped++
				return true
			})
			return sl.LogRecords().Len() == 0
		})
		return rl.ScopeLogs().Len() == 0
	})
	return dropped
}

func (s *Server) keepRecord(traceID pcommon.TraceID) bool {
	if !traceID.IsEmpty() {
		return keepTrace(traceID)
	}
	draw := s.cfg.Rand
	if draw == nil {
		draw = rand.Uint64
	}
	return draw()%quotaSampleRate == 0
}

func (s *Server) overQuota(workspaceID string) bool {
	return s.cfg.OverQuota != nil && s.cfg.OverQuota(workspaceID)
}

// dropReason pairs the Prometheus label a drop is counted under with the
// api_key_health column it lands in (D162). They travel together so the two
// surfaces cannot drift: one call site per drop, both counters, one vocabulary.
type dropReason struct {
	metric string
	column metering.DropReason
}

var (
	dropDecode      = dropReason{metrics.ReasonDecode, metering.DropDecode}
	dropUnsupported = dropReason{metrics.ReasonUnsupported, metering.DropUnsupported}
	dropQuota       = dropReason{metrics.ReasonQuota, metering.DropQuota}
	dropCardinality = dropReason{metrics.ReasonCardinality, metering.DropCardinality}
)

// countDrop records records lost after auth, in both places a drop is visible:
// obstack_ingest_dropped_total for operators and the workspace's health row for
// the product. Zero is a no-op — an export that lost nothing must not put a
// series or a row anywhere.
//
// Panic drops go straight to Prometheus instead: a handler that died mid-batch
// cannot say how many records it had already enqueued, so there is no honest
// number to add to a health column (D162 keeps those columns to the reasons the
// receive path can count exactly).
func (s *Server) countDrop(identity auth.Identity, reason dropReason, records int) {
	if records <= 0 {
		return
	}
	metrics.Dropped.WithLabelValues(identity.WorkspaceID, reason.metric).Add(float64(records))
	if s.cfg.Meter != nil {
		s.cfg.Meter.RecordDropped(identity.WorkspaceID, identity.KeyID, reason.column, int64(records))
	}
}

func (s *Server) meterAccepted(identity auth.Identity, spans, logs int64) {
	if s.cfg.Meter != nil {
		s.cfg.Meter.RecordAccepted(identity.WorkspaceID, identity.KeyID, spans, logs)
	}
}

func (s *Server) meterAcceptedMetrics(identity auth.Identity, points int64) {
	if s.cfg.Meter != nil {
		s.cfg.Meter.RecordAcceptedMetrics(identity.WorkspaceID, identity.KeyID, points)
	}
}
