package receive

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"time"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/changes"
)

// changesPath is where the change-event ingest lives (S7.2 packet, D493):
// beside the OTLP routes and the launch receivers, on the listener the
// quickstart already documents, under the same bearer key.
const changesPath = "/v1/changes"

// maxChangeBytes caps one document (D494). The 16 MiB OTLP cap is for
// telemetry batches; an annotation that needs more than 64 KiB is not one.
const maxChangeBytes = 64 << 10

// changesHandler serves one POST /v1/changes.
//
// Like the drain handlers it does not go through export(): that path speaks
// OTLP's encodings and Status messages, and this route speaks plain JSON.
// What it shares is what matters — the bearer resolution, the health-row
// accounting, the panic recovery's JSON dialect. The order of refusals is the
// cheapest first: a key, then the cap (a flood costs no parse and no
// Postgres), then the media type, the body, the document, the write.
func (s *Server) changesHandler(w http.ResponseWriter, r *http.Request) {
	identity, err := s.cfg.Auth.Workspace(r.Header.Get("Authorization"))
	if err != nil {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeJSONError(w, http.StatusUnauthorized, "missing or unknown API key")
		return
	}
	if slot, ok := r.Context().Value(workspaceKey{}).(*string); ok {
		*slot = identity.WorkspaceID
	}

	now := time.Now()
	if !s.changeLimiter.Allow(identity.WorkspaceID, now) {
		// Counted for operators only: nothing was decoded or written, and the
		// health columns are for records the receive path could count (D162).
		changes.Refused(changes.RefusedRateLimited)
		w.Header().Set("Retry-After", "60")
		writeJSONError(w, http.StatusTooManyRequests, changes.RateCapMessage)
		return
	}

	// JSON only, uncompressed (D494). Past auth, so a refusal here is a known
	// workspace sending something we will not read: dropped_unsupported, the
	// OTLP path's own column for an encoding it does not take.
	if r.Header.Get("Content-Encoding") != "" {
		s.countDrop(identity, dropUnsupported, 1)
		changes.Refused(string(changes.RefusedDecode))
		writeJSONError(w, http.StatusUnsupportedMediaType, "Content-Encoding is not accepted; send the document uncompressed")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		s.countDrop(identity, dropUnsupported, 1)
		changes.Refused(string(changes.RefusedDecode))
		writeJSONError(w, http.StatusUnsupportedMediaType, "unreadable Content-Type; expected "+contentTypeJSON)
		return
	}
	if mediaType != contentTypeJSON {
		s.countDrop(identity, dropUnsupported, 1)
		changes.Refused(string(changes.RefusedDecode))
		writeJSONError(w, http.StatusUnsupportedMediaType, "unsupported Content-Type "+mediaType+"; expected "+contentTypeJSON)
		return
	}

	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxChangeBytes))
	if err != nil {
		s.countDrop(identity, dropDecode, 1)
		changes.Refused(string(changes.RefusedDecode))
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "payload is over the 64KiB limit")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "unreadable request body")
		return
	}

	ev, ref := changes.Parse(raw, now)
	if ref != nil {
		// D6: one 4xx ends it, and the field is named so the fix is one edit.
		// A 400 is a dropped_decode on the key's health row (D497).
		s.countDrop(identity, dropDecode, 1)
		changes.Refused(string(ref.Kind))
		writeJSONError(w, http.StatusBadRequest, ref.Error())
		return
	}

	id, deduplicated, err := s.cfg.Changes.Insert(r.Context(), identity, ev)
	if err != nil {
		switch {
		case errors.Is(err, changes.ErrUnknownKey):
			// The credential's row is gone: the answer its next request gets.
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeJSONError(w, http.StatusUnauthorized, "missing or unknown API key")
		case errors.Is(err, changes.ErrInvariant):
			// Ours, not theirs: the validator passed what the DDL refused.
			slog.Error("change event refused by the store after validation", "workspace_id", identity.WorkspaceID, "error", err)
			changes.Refused(changes.RefusedStorage)
			writeJSONError(w, http.StatusInternalServerError, "internal error handling delivery")
		default:
			// D495: a write that did not happen is a 503, never a 2xx. The
			// document is not logged — it is the customer's, and a log line is
			// not where it goes.
			slog.Warn("change event not stored", "workspace_id", identity.WorkspaceID, "error", err)
			changes.Refused(changes.RefusedStorage)
			writeJSONError(w, http.StatusServiceUnavailable, "storage unavailable")
		}
		return
	}

	if deduplicated {
		// Nothing was written, so nothing is accepted: the key is alive, but
		// its health row counts events, and this was not one.
		changes.Deduplicated()
		writeChangeAnswer(w, http.StatusOK, id, true)
		return
	}
	changes.Accepted(ev.Kind)
	if s.cfg.Meter != nil {
		s.cfg.Meter.RecordAcceptedChange(identity.WorkspaceID, identity.KeyID)
	}
	writeChangeAnswer(w, http.StatusCreated, id, false)
}

// writeChangeAnswer is the 2xx: the row's id and whether it was already there.
func writeChangeAnswer(w http.ResponseWriter, status int, id string, deduplicated bool) {
	body, err := json.Marshal(struct {
		ID           string `json:"id"`
		Deduplicated bool   `json:"deduplicated"`
	}{id, deduplicated})
	if err != nil {
		body = nil
	}
	w.Header().Set("Content-Type", contentTypeJSON)
	w.WriteHeader(status)
	w.Write(body)
}
