package receive

import (
	"context"
	"log/slog"
	"runtime/debug"

	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	// Registers the gzip compressor so exports from clients that compress —
	// which is most of them — are readable.
	_ "google.golang.org/grpc/encoding/gzip"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
)

func (s *Server) newGRPCServer() *grpc.Server {
	srv := grpc.NewServer(
		grpc.MaxRecvMsgSize(maxRequestBytes),
		// The decoder runs ahead of every interceptor, so it needs its own guard.
		grpc.ForceServerCodecV2(recoverCodec{protoCodec()}),
		// Recovery sits inside auth, not outside it, so the drop can be labelled
		// with the workspace whose payload caused it. Nothing in authenticate
		// touches the payload, so the poison-payload surface is entirely within
		// the recovered span.
		grpc.ChainUnaryInterceptor(s.authenticate, recoverPanic),
	)
	ptraceotlp.RegisterGRPCServer(srv, &traceService{srv: s})
	plogotlp.RegisterGRPCServer(srv, &logService{srv: s})
	return srv
}

// authenticate resolves the bearer key before the payload is even looked at, so
// an unknown key never reaches a consumer.
func (s *Server) authenticate(ctx context.Context, req any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
	var authorization string
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if values := md.Get("authorization"); len(values) > 0 {
			authorization = values[0]
		}
	}
	workspaceID, err := s.cfg.Auth.Workspace(authorization)
	if err != nil {
		return nil, status.Error(codes.Unauthenticated, err.Error())
	}
	return handler(auth.ContextWithWorkspace(ctx, workspaceID), req)
}

// recoverPanic turns a panicking handler into one counted drop and one terminal
// error instead of a dead process (D26). grpc-go would otherwise let the panic
// unwind through the serving goroutine and crash the service, taking every other
// workspace's telemetry with it. codes.Internal is outside the OTLP retryable
// set, so the exporter does not re-send the payload that caused it.
func recoverPanic(ctx context.Context, req any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp any, err error) {
	defer func() {
		if p := recover(); p != nil {
			slog.Error("panic serving otlp export",
				"transport", "grpc", "panic", p, "stack", string(debug.Stack()))
			metrics.Dropped.WithLabelValues(auth.WorkspaceFromContext(ctx), metrics.ReasonPanic).Inc()
			resp, err = nil, status.Error(codes.Internal, "internal error handling export")
		}
	}()
	return handler(ctx, req)
}

// A payload that fails to decode — including one that makes the decoder itself
// panic, see recoverCodec — is rejected by grpc-go's codec before it reaches
// these handlers, with codes.Internal — outside the OTLP retryable set, so the
// D6 "one terminal error, never a retry loop" posture holds. Unlike the HTTP
// path the codec runs before the auth interceptor, so there is not even a
// workspace to label a drop with: gRPC decode failures show up in the gRPC
// error, not in obstack_ingest_dropped_total.

type traceService struct {
	ptraceotlp.UnimplementedGRPCServer
	srv *Server
}

func (t *traceService) Export(ctx context.Context, req ptraceotlp.ExportRequest) (ptraceotlp.ExportResponse, error) {
	t.srv.consumeTraces(ctx, auth.WorkspaceFromContext(ctx), req)
	return ptraceotlp.NewExportResponse(), nil
}

type logService struct {
	plogotlp.UnimplementedGRPCServer
	srv *Server
}

func (l *logService) Export(ctx context.Context, req plogotlp.ExportRequest) (plogotlp.ExportResponse, error) {
	l.srv.consumeLogs(ctx, auth.WorkspaceFromContext(ctx), req)
	return plogotlp.NewExportResponse(), nil
}
