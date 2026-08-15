package receive

import (
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	grpcencoding "google.golang.org/grpc/encoding"
	"google.golang.org/grpc/mem"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/wrapperspb"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
)

// poisonCodec is the decoder that a poison payload would produce: it panics on
// its first Unmarshal and behaves normally afterwards, so one test can watch a
// codec panic being converted and then watch the next export be served.
type poisonCodec struct {
	grpcencoding.CodecV2
	panicked atomic.Bool
}

func (c *poisonCodec) Unmarshal(data mem.BufferSlice, v any) error {
	if c.panicked.CompareAndSwap(false, true) {
		panic("decoder exploded on a malformed message")
	}
	return c.CodecV2.Unmarshal(data, v)
}

// A panicking decoder must cost the service one export, not the process: the
// panic becomes an unmarshal error, grpc-go rejects it with its normal terminal
// code, and the next export decodes and reaches the consumer as if nothing had
// happened. The drop is not counted — the codec runs ahead of auth, so there is
// no workspace to label it with (D26).
func TestCodecPanicIsRecoveredAsTerminalError(t *testing.T) {
	consumer := &countingConsumer{}
	client := startCodecServer(t, consumer, recoverCodec{&poisonCodec{CodecV2: protoCodec()}})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+codecTestKey)

	req := ptraceotlp.NewExportRequestFromTraces(codecTraceFixture())

	_, err := client.Export(ctx, req)
	if got := status.Code(err); got == codes.OK || retryable[got] {
		t.Fatalf("export over a panicking decoder: code = %s, want a terminal (non-retryable) code", got)
	}
	if got := consumer.count(); got != 0 {
		t.Fatalf("consumer saw %d traces from a payload that never decoded", got)
	}

	if _, err := client.Export(ctx, req); err != nil {
		t.Fatalf("export after a decoder panic: %v", err)
	}
	if got := consumer.count(); got != 1 {
		t.Fatalf("consumed %d traces after the decoder recovered, want 1", got)
	}
}

// retryable is the OTLP spec's set of gRPC codes an exporter re-sends on.
var retryable = map[codes.Code]bool{
	codes.Canceled:         true,
	codes.DeadlineExceeded: true,
	codes.Aborted:          true,
	codes.OutOfRange:       true,
	codes.Unavailable:      true,
	codes.DataLoss:         true,
}

// The wrapper guards a panic and nothing else: the bytes it produces, the
// message it decodes and the content-subtype it names are the proto codec's, so
// a guarded server is wire-identical to an unguarded one.
func TestRecoverCodecDelegatesToTheProtoCodec(t *testing.T) {
	inner := protoCodec()
	guarded := recoverCodec{inner}

	if guarded.Name() != inner.Name() {
		t.Fatalf("guarded codec name = %q, want %q", guarded.Name(), inner.Name())
	}

	want, err := inner.Marshal(wrapperspb.String("hello"))
	if err != nil {
		t.Fatalf("marshal with the proto codec: %v", err)
	}
	got, err := guarded.Marshal(wrapperspb.String("hello"))
	if err != nil {
		t.Fatalf("marshal with the guarded codec: %v", err)
	}
	if string(got.Materialize()) != string(want.Materialize()) {
		t.Fatal("guarded codec marshalled different bytes than the proto codec")
	}

	var decoded wrapperspb.StringValue
	if err := guarded.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("unmarshal with the guarded codec: %v", err)
	}
	if decoded.GetValue() != "hello" {
		t.Fatalf("guarded codec decoded %q, want %q", decoded.GetValue(), "hello")
	}
}

const (
	codecTestKey     = "ok_dev_codec"
	codecWorkspaceID = "ws_codec"
)

// startCodecServer serves the trace service over the given codec, with the same
// interceptor chain the real server uses, and returns a client for it.
func startCodecServer(t *testing.T, consumer Consumer, codec grpcencoding.CodecV2) ptraceotlp.GRPCClient {
	t.Helper()

	s := &Server{cfg: Config{
		Auth:     auth.New(map[string]string{codecTestKey: codecWorkspaceID}),
		Consumer: consumer,
	}}
	srv := grpc.NewServer(
		grpc.ForceServerCodecV2(codec),
		grpc.ChainUnaryInterceptor(s.authenticate, recoverPanic),
	)
	ptraceotlp.RegisterGRPCServer(srv, &traceService{srv: s})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go srv.Serve(ln)
	t.Cleanup(srv.Stop)

	conn, err := grpc.NewClient(ln.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial %s: %v", ln.Addr(), err)
	}
	t.Cleanup(func() { conn.Close() })

	return ptraceotlp.NewGRPCClient(conn)
}

// countingConsumer only has to say how many exports made it through the codec.
type countingConsumer struct {
	traces atomic.Int64
}

func (c *countingConsumer) ConsumeTraces(context.Context, string, ptrace.Traces) { c.traces.Add(1) }
func (c *countingConsumer) ConsumeLogs(context.Context, string, plog.Logs)       {}
func (c *countingConsumer) count() int64                                         { return c.traces.Load() }

func codecTraceFixture() ptrace.Traces {
	td := ptrace.NewTraces()
	span := td.ResourceSpans().AppendEmpty().ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	span.SetName("POST /chat")
	span.SetTraceID(pcommon.TraceID{0x4b, 0xf9, 0x2f, 0x35, 0x77, 0xb3, 0x4d, 0xa6, 0xa3, 0xce, 0x92, 0x9d, 0x0e, 0x0e, 0x47, 0x36})
	span.SetSpanID(pcommon.SpanID{0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7})
	return td
}
