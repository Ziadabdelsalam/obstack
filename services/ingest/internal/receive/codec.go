package receive

import (
	"fmt"
	"log/slog"
	"runtime/debug"

	grpcencoding "google.golang.org/grpc/encoding"
	"google.golang.org/grpc/encoding/proto"
	"google.golang.org/grpc/mem"
)

// recoverCodec is grpc-go's own proto codec plus a recover in Unmarshal, and
// nothing else: Marshal and Name are the embedded codec's, so the wire format,
// the buffer pooling and the content-subtype are untouched.
//
// It exists because the codec decodes the payload before any interceptor runs,
// so the D26 panic recovery on the handler chain cannot see a decoder that blows
// up on a malformed message — that panic would unwind through the serving
// goroutine and kill the process, taking every workspace's telemetry with it. A
// recovered panic becomes an unmarshal error, which grpc-go answers exactly as
// it answers any undecodable payload: codes.Internal, terminal for OTLP
// exporters, so the poison bytes are never re-sent.
//
// The drop stays uncounted, as ratified in D26: this runs ahead of auth, so
// there is no workspace to label the counter with.
//
// One residual is accepted for Phase 1: grpc-go's recvAndDecompress runs the
// stdlib gzip reader before the codec with no user hook in front of it, so a
// panic there — which would be a Go stdlib bug, since gzip returns errors on
// hostile input by design — stays unrecoverable; revisit rides any future
// grpc-go bump.
type recoverCodec struct{ grpcencoding.CodecV2 }

func (c recoverCodec) Unmarshal(data mem.BufferSlice, v any) (err error) {
	defer func() {
		if p := recover(); p != nil {
			slog.Error("panic decoding otlp payload",
				"transport", "grpc", "panic", p, "stack", string(debug.Stack()))
			err = fmt.Errorf("panic decoding otlp payload: %v", p)
		}
	}()
	return c.CodecV2.Unmarshal(data, v)
}

// protoCodec returns the default proto codec to be guarded. It is the same
// instance grpc-go would have looked up itself for application/grpc+proto.
func protoCodec() grpcencoding.CodecV2 { return grpcencoding.GetCodecV2(proto.Name) }
