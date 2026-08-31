package receive

import (
	"compress/gzip"
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"runtime/debug"
	"strings"

	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
)

// The two payload encodings OTLP/HTTP defines. Both are mandatory for us: the
// OTel SDKs default to protobuf, while JSON is what curl-driven debugging and
// browser-side exporters send.
const (
	contentTypeProto = "application/x-protobuf"
	contentTypeJSON  = "application/json"
)

// integrationsPrefix is where the launch receivers live (D289 — these paths are
// operator-facing configuration and do not move). It is a constant because the
// panic recovery below has to recognise them to answer in their dialect, and a
// second spelling of the prefix would eventually answer one of them wrongly.
const integrationsPrefix = "/v1/integrations/"

type encoding int

const (
	encodingProto encoding = iota
	encodingJSON
)

// payload is the shared shape of the ptraceotlp/plogotlp export requests and
// responses: one message, two encodings.
type payload interface {
	UnmarshalProto([]byte) error
	UnmarshalJSON([]byte) error
	MarshalProto() ([]byte, error)
	MarshalJSON() ([]byte, error)
}

func (s *Server) httpHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/traces", func(w http.ResponseWriter, r *http.Request) {
		req := ptraceotlp.NewExportRequest()
		s.export(w, r, req, func(ctx context.Context) payload {
			s.consumeTraces(ctx, auth.IdentityFromContext(ctx).WorkspaceID, req)
			return ptraceotlp.NewExportResponse()
		})
	})
	mux.HandleFunc("POST /v1/logs", func(w http.ResponseWriter, r *http.Request) {
		req := plogotlp.NewExportRequest()
		s.export(w, r, req, func(ctx context.Context) payload {
			s.consumeLogs(ctx, auth.IdentityFromContext(ctx).WorkspaceID, req)
			return plogotlp.NewExportResponse()
		})
	})
	mux.HandleFunc("POST /v1/metrics", func(w http.ResponseWriter, r *http.Request) {
		req := pmetricotlp.NewExportRequest()
		s.export(w, r, req, func(ctx context.Context) payload {
			s.consumeMetrics(ctx, auth.IdentityFromContext(ctx).WorkspaceID, req)
			return pmetricotlp.NewExportResponse()
		})
	})
	// The launch receivers (D101/D254). They are routes here rather than a
	// second listener because everything a second listener would need — the
	// bearer path, metering, health rows, quota, the panic recovery below —
	// already exists on this one. Their names are stable operator-facing
	// configuration (D289).
	mux.HandleFunc("POST "+integrationsPrefix+"vercel", s.vercelHandler)
	mux.HandleFunc("POST "+integrationsPrefix+"cloudwatch", s.cloudWatchHandler)
	return recoverPanics(mux)
}

// workspaceKey addresses the slot recoverPanics puts in the request context and
// export fills once auth resolves. A handler that panics never returns, so this
// is the only way the recovery gets the workspace to label the drop with.
type workspaceKey struct{}

// recoverPanics keeps a poison payload from taking the process down (D26): the
// records in flight are lost and counted, the exporter gets one terminal error —
// OTLP/HTTP marks 500 non-retryable, so it will not re-send the same bytes — and
// the service stays up for every other workspace.
func recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		workspaceID := new(string)
		defer func() {
			p := recover()
			if p == nil {
				return
			}
			// net/http's own signal for "drop this connection"; it is not a
			// failure and must keep propagating.
			if p == http.ErrAbortHandler {
				panic(p)
			}
			slog.Error("panic serving export",
				"path", r.URL.Path, "panic", p, "stack", string(debug.Stack()))
			metrics.Dropped.WithLabelValues(*workspaceID, metrics.ReasonPanic).Inc()
			// The answer has to be in the dialect the caller speaks: the OTLP
			// routes get a google.rpc.Status in the request's encoding, the
			// integration routes get the same plain JSON they answer with
			// everywhere else. A drain sender handed a protobuf Status would
			// log bytes instead of a reason.
			if strings.HasPrefix(r.URL.Path, integrationsPrefix) {
				writeJSONError(w, http.StatusInternalServerError, "internal error handling delivery")
				return
			}
			enc, _ := requestEncoding(r)
			writeError(w, enc, http.StatusInternalServerError, codes.Internal, "internal error handling export")
		}()
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), workspaceKey{}, workspaceID)))
	})
}

// export runs one request end to end: authenticate, decode into req, then hand
// the decoded payload to accept, which consumes it and returns the message to
// acknowledge with. accept is handed a context carrying the resolved identity —
// the shape the gRPC interceptor already hands its handlers, so the shared
// consume path has one place to read who a request was.
func (s *Server) export(w http.ResponseWriter, r *http.Request, req payload, accept func(ctx context.Context) payload) {
	// The encoding is resolved before anything else so that every answer,
	// including the ones that never look at the body, carries its Status in the
	// encoding the client sent — OTLP/HTTP requires the response to match the
	// request. An unreadable Content-Type falls back to protobuf.
	enc, encErr := requestEncoding(r)

	identity, err := s.cfg.Auth.Workspace(r.Header.Get("Authorization"))
	if err != nil {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeError(w, enc, http.StatusUnauthorized, codes.Unauthenticated, err.Error())
		return
	}
	workspaceID := identity.WorkspaceID
	if slot, ok := r.Context().Value(workspaceKey{}).(*string); ok {
		*slot = workspaceID
	}

	// Checked after auth: an unauthenticated caller learns nothing about which
	// encodings the endpoint takes.
	if encErr != nil {
		// Past auth, so this is telemetry from a known workspace that we
		// refused: a drop like any other (D26), counted one per request because
		// a body we will not read has no knowable record count.
		s.countDrop(identity, dropUnsupported, 1)
		writeError(w, enc, http.StatusUnsupportedMediaType, codes.InvalidArgument, encErr.Error())
		return
	}

	body, err := readBody(w, r)
	if err != nil {
		// A body we cannot even read is telemetry lost past the point where the
		// service took the request, so it is counted like any other decode
		// failure — otherwise an exporter shipping unreadable bytes is a silent
		// hole in the pipeline. One, not a record count: how many records an
		// unreadable payload held is unknowable.
		s.countDrop(identity, dropDecode, 1)
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, enc, http.StatusRequestEntityTooLarge, codes.InvalidArgument, "payload is over the 16MiB limit")
			return
		}
		writeError(w, enc, http.StatusBadRequest, codes.InvalidArgument, "unreadable request body: "+err.Error())
		return
	}

	if err := unmarshal(req, enc, body); err != nil {
		// D6: a payload we cannot read is the client's problem, and one 4xx
		// ends it. A 5xx here would have the exporter re-send the same
		// unreadable bytes on every retry.
		s.countDrop(identity, dropDecode, 1)
		writeError(w, enc, http.StatusBadRequest, codes.InvalidArgument, "malformed OTLP payload: "+err.Error())
		return
	}

	resp := accept(auth.ContextWithIdentity(r.Context(), identity))
	writeSuccess(w, enc, resp)
}

func requestEncoding(r *http.Request) (encoding, error) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		return encodingProto, errors.New("unreadable Content-Type; expected " + contentTypeProto + " or " + contentTypeJSON)
	}
	switch mediaType {
	case contentTypeProto:
		return encodingProto, nil
	case contentTypeJSON:
		return encodingJSON, nil
	default:
		return encodingProto, errors.New("unsupported Content-Type " + mediaType + "; expected " + contentTypeProto + " or " + contentTypeJSON)
	}
}

// readBody applies the size cap and undoes the gzip that exporters commonly
// apply. The cap covers the decompressed stream as well: capping only the wire
// bytes would let a few hundred compressed KiB expand into gigabytes of heap,
// which is the exhaustion the cap exists to prevent.
func readBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	var body io.Reader = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	if r.Header.Get("Content-Encoding") == "gzip" {
		gz, err := gzip.NewReader(body)
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		body = io.LimitReader(gz, maxRequestBytes+1)
	}
	read, err := io.ReadAll(body)
	if err != nil {
		return nil, err
	}
	if len(read) > maxRequestBytes {
		return nil, &http.MaxBytesError{Limit: maxRequestBytes}
	}
	return read, nil
}

func unmarshal(p payload, enc encoding, body []byte) error {
	if enc == encodingJSON {
		return p.UnmarshalJSON(body)
	}
	return p.UnmarshalProto(body)
}

func writeSuccess(w http.ResponseWriter, enc encoding, resp payload) {
	body, err := marshal(resp, enc)
	if err != nil {
		// Marshalling an empty response cannot realistically fail; if it does,
		// the records are already enqueued, so still answer 200 rather than
		// have the exporter re-send them.
		body = nil
	}
	w.Header().Set("Content-Type", contentTypeOf(enc))
	w.WriteHeader(http.StatusOK)
	w.Write(body)
}

func marshal(p payload, enc encoding) ([]byte, error) {
	if enc == encodingJSON {
		return p.MarshalJSON()
	}
	return p.MarshalProto()
}

// writeError answers with the google.rpc.Status message OTLP/HTTP prescribes,
// in the same encoding the request used, so exporters log the reason instead of
// a bare status line.
func writeError(w http.ResponseWriter, enc encoding, httpStatus int, code codes.Code, message string) {
	st := status.New(code, message).Proto()

	var (
		body []byte
		err  error
	)
	if enc == encodingJSON {
		body, err = protojson.Marshal(st)
	} else {
		body, err = proto.Marshal(st)
	}
	if err != nil {
		body = nil
	}
	w.Header().Set("Content-Type", contentTypeOf(enc))
	w.WriteHeader(httpStatus)
	w.Write(body)
}

func contentTypeOf(enc encoding) string {
	if enc == encodingJSON {
		return contentTypeJSON
	}
	return contentTypeProto
}
