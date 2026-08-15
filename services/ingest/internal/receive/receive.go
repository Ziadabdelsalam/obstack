// Package receive serves the two OTLP transports (D3): gRPC on :4317 and HTTP
// on :4318 at /v1/traces and /v1/logs, in application/x-protobuf and
// application/json. Both transports authenticate with the D4 bearer keys, share
// one decode path, and answer per the D6 error posture — a payload that cannot
// be unmarshalled is one 4xx and one counted drop, never a 5xx that would put
// an exporter into a retry loop.
package receive

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
	"google.golang.org/grpc"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
)

// Consumer takes decoded, authenticated telemetry off the wire. It cannot fail
// the request: per D23 the OTLP response acknowledges enqueue, not the
// ClickHouse write, so a consumer that later loses the batch counts a drop with
// reason "write" instead of turning it into an exporter error.
type Consumer interface {
	ConsumeTraces(ctx context.Context, workspaceID string, td ptrace.Traces)
	ConsumeLogs(ctx context.Context, workspaceID string, ld plog.Logs)
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
}

// Server owns both OTLP listeners.
type Server struct {
	cfg Config

	grpc *grpc.Server
	http *http.Server

	grpcLn net.Listener
	httpLn net.Listener

	errs chan error
}

// New builds the receivers. Nothing is bound until Start.
func New(cfg Config) *Server {
	s := &Server{cfg: cfg, errs: make(chan error, 2)}
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

// consumeTraces hands the payload on and counts what was accepted. Counting
// happens here, after auth and decode, because that is exactly the point where
// the service takes responsibility for the records (D23).
func (s *Server) consumeTraces(ctx context.Context, workspaceID string, req ptraceotlp.ExportRequest) {
	td := req.Traces()
	s.cfg.Consumer.ConsumeTraces(ctx, workspaceID, td)
	metrics.Accepted.WithLabelValues(workspaceID, metrics.SignalTraces).Add(float64(td.SpanCount()))
}

func (s *Server) consumeLogs(ctx context.Context, workspaceID string, req plogotlp.ExportRequest) {
	ld := req.Logs()
	s.cfg.Consumer.ConsumeLogs(ctx, workspaceID, ld)
	metrics.Accepted.WithLabelValues(workspaceID, metrics.SignalLogs).Add(float64(ld.LogRecordCount()))
}

// countDecodeDrop records a payload the service could not read. It counts one,
// not a record count: how many records a corrupt payload held is unknowable.
func countDecodeDrop(workspaceID string) {
	metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonDecode).Inc()
}
