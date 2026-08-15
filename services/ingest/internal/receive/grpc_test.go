package receive_test

import (
	"context"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/encoding/gzip"
	"google.golang.org/grpc/mem"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/receive"
)

func dial(t *testing.T, srv *receive.Server) *grpc.ClientConn {
	t.Helper()

	conn, err := grpc.NewClient(srv.GRPCAddr(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial %s: %v", srv.GRPCAddr(), err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func exportContext(t *testing.T, bearer string) (context.Context, context.CancelFunc) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if bearer != "" {
		ctx = metadata.AppendToOutgoingContext(ctx, "authorization", bearer)
	}
	return ctx, cancel
}

func TestGRPCAcceptsValidExport(t *testing.T) {
	cases := []struct {
		name string
		opts []grpc.CallOption
	}{
		{"uncompressed", nil},
		{"gzipped", []grpc.CallOption{grpc.UseCompressor(gzip.Name)}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, rec := startServer(t)
			conn := dial(t, srv)

			ctx, cancel := exportContext(t, "Bearer "+testKey)
			defer cancel()

			accepted := metrics.Accepted.WithLabelValues(workspaceID, metrics.SignalTraces)
			before := testutil.ToFloat64(accepted)

			if _, err := ptraceotlp.NewGRPCClient(conn).Export(ctx, ptraceotlp.NewExportRequestFromTraces(traceFixture()), tc.opts...); err != nil {
				t.Fatalf("export traces: %v", err)
			}
			if _, err := plogotlp.NewGRPCClient(conn).Export(ctx, plogotlp.NewExportRequestFromLogs(logFixture()), tc.opts...); err != nil {
				t.Fatalf("export logs: %v", err)
			}

			if traces, logs := rec.counts(); traces != 1 || logs != 1 {
				t.Fatalf("consumed (traces=%d logs=%d), want (1, 1)", traces, logs)
			}
			if got := rec.lastWorkspace(); got != workspaceID {
				t.Fatalf("consumed for workspace %q, want %q", got, workspaceID)
			}
			if delta := testutil.ToFloat64(accepted) - before; delta != 2 {
				t.Fatalf("obstack_ingest_accepted_total delta = %v, want 2", delta)
			}
		})
	}
}

func TestGRPCRejectsBadKey(t *testing.T) {
	cases := []struct {
		name   string
		bearer string
	}{
		{"missing metadata", ""},
		{"unknown key", "Bearer ok_dev_nope"},
		{"wrong scheme", "Basic " + testKey},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, rec := startServer(t)
			conn := dial(t, srv)

			ctx, cancel := exportContext(t, tc.bearer)
			defer cancel()

			_, err := ptraceotlp.NewGRPCClient(conn).Export(ctx, ptraceotlp.NewExportRequestFromTraces(traceFixture()))
			if got := status.Code(err); got != codes.Unauthenticated {
				t.Fatalf("export traces code = %s, want Unauthenticated", got)
			}
			_, err = plogotlp.NewGRPCClient(conn).Export(ctx, plogotlp.NewExportRequestFromLogs(logFixture()))
			if got := status.Code(err); got != codes.Unauthenticated {
				t.Fatalf("export logs code = %s, want Unauthenticated", got)
			}

			if traces, logs := rec.counts(); traces != 0 || logs != 0 {
				t.Fatalf("consumer saw (traces=%d logs=%d) from an unauthenticated export", traces, logs)
			}
		})
	}
}

// A consumer that panics must cost the service one request, not the process
// (D26): the drop is counted for the workspace that sent it, the exporter gets
// codes.Internal — terminal, so it does not re-send the payload — and the next
// export is served as if nothing happened.
func TestGRPCPanicIsRecoveredAndCounted(t *testing.T) {
	srv := startServerWith(t, panicker{})
	conn := dial(t, srv)

	ctx, cancel := exportContext(t, "Bearer "+testKey)
	defer cancel()

	dropped := metrics.Dropped.WithLabelValues(workspaceID, metrics.ReasonPanic)
	before := testutil.ToFloat64(dropped)

	// Twice: the second call only succeeds in reaching a handler if the first
	// panic left the server serving.
	for i := range 2 {
		_, err := ptraceotlp.NewGRPCClient(conn).Export(ctx, ptraceotlp.NewExportRequestFromTraces(traceFixture()))
		if got := status.Code(err); got != codes.Internal {
			t.Fatalf("export %d code = %s, want Internal", i, got)
		}
	}
	_, err := plogotlp.NewGRPCClient(conn).Export(ctx, plogotlp.NewExportRequestFromLogs(logFixture()))
	if got := status.Code(err); got != codes.Internal {
		t.Fatalf("export logs code = %s, want Internal", got)
	}

	if delta := testutil.ToFloat64(dropped) - before; delta != 3 {
		t.Fatalf("obstack_ingest_dropped_total{reason=panic} delta = %v, want 3", delta)
	}
	if retryableCodes[codes.Internal] {
		t.Fatal("codes.Internal is retryable; a panic would become a retry loop")
	}
}

// retryableCodes is the OTLP spec's set of gRPC codes an exporter re-sends on.
// Everything outside it is terminal for the client.
var retryableCodes = map[codes.Code]bool{
	codes.Canceled:         true,
	codes.DeadlineExceeded: true,
	codes.Aborted:          true,
	codes.OutOfRange:       true,
	codes.Unavailable:      true,
	codes.DataLoss:         true,
}

// A gRPC payload that fails to decode is rejected by grpc-go's codec before any
// handler runs, and the code it answers with (Internal) is terminal for OTLP
// exporters — so the D6 "never a retry loop over unreadable bytes" posture
// holds on this transport too. The drop is not counted here: unlike the HTTP
// path there is no hook inside the codec.
func TestGRPCGarbagePayloadIsNotRetryable(t *testing.T) {
	srv, rec := startServer(t)
	conn := dial(t, srv)

	ctx, cancel := exportContext(t, "Bearer "+testKey)
	defer cancel()

	var reply any
	err := conn.Invoke(ctx, "/opentelemetry.proto.collector.trace.v1.TraceService/Export",
		[]byte("this is not an OTLP payload"), &reply, grpc.ForceCodecV2(rawCodec{}))
	if got := status.Code(err); got == codes.OK || retryableCodes[got] {
		t.Fatalf("code = %s, want a terminal (non-retryable) code", got)
	}
	if traces, _ := rec.counts(); traces != 0 {
		t.Fatalf("consumer saw %d traces from a malformed payload", traces)
	}
}

// rawCodec puts arbitrary bytes on the wire in place of a proto message. It
// names itself "proto" so the server still picks its own proto codec — which is
// exactly the component under test.
type rawCodec struct{}

func (rawCodec) Marshal(v any) (mem.BufferSlice, error) {
	return mem.BufferSlice{mem.SliceBuffer(v.([]byte))}, nil
}

func (rawCodec) Unmarshal(mem.BufferSlice, any) error { return nil }

func (rawCodec) Name() string { return "proto" }
