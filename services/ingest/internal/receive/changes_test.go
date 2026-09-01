package receive_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/changes"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metering"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/receive"
)

// fakeChangeStore records what the handler asked it to write and answers
// whatever the test configured: the HTTP contract is the handler's, the
// dedupe and the FK truths are the real store's (store_integration_test.go).
type fakeChangeStore struct {
	mu      sync.Mutex
	inserts []changeInsert
	id      string
	dedup   bool
	err     error
	panics  bool
}

type changeInsert struct {
	identity auth.Identity
	event    changes.Event
}

func (s *fakeChangeStore) Insert(_ context.Context, identity auth.Identity, ev changes.Event) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.panics {
		panic("store exploded")
	}
	s.inserts = append(s.inserts, changeInsert{identity, ev})
	if s.err != nil {
		return "", false, s.err
	}
	return s.id, s.dedup, nil
}

func (s *fakeChangeStore) calls() []changeInsert {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]changeInsert(nil), s.inserts...)
}

type changeResponse struct {
	status  int
	headers http.Header
	body    string
}

func postChange(t *testing.T, srv *receive.Server, token, contentType string, body string, headers ...string) changeResponse {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, "http://"+srv.HTTPAddr()+"/v1/changes", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return changeResponse{resp.StatusCode, resp.Header, string(raw)}
}

func changesServer(t *testing.T, store *fakeChangeStore) (*receive.Server, *fakeMeter) {
	t.Helper()
	meter := &fakeMeter{}
	srv := start(t, serverOptions{consumer: &recorder{}, meter: meter, changes: store, extraKeys: map[string]string{"bob-key": "ws_bob"}})
	return srv, meter
}

const validChange = `{"kind":"deploy","service":"checkout","ref":"8963ae2","title":"deploy 8963ae2","who":"ziad","source":"github-actions","external_id":"run:1","link":{"label":"run","href":"https://ci.example/1"}}`

func TestChangesRequiresAKey(t *testing.T) {
	store := &fakeChangeStore{id: "chg_0000000000000001"}
	srv, _ := changesServer(t, store)
	for _, token := range []string{"", "not-a-key"} {
		resp := postChange(t, srv, token, "application/json", validChange)
		if resp.status != http.StatusUnauthorized || resp.headers.Get("WWW-Authenticate") != "Bearer" {
			t.Errorf("token %q: status %d, WWW-Authenticate %q", token, resp.status, resp.headers.Get("WWW-Authenticate"))
		}
		if resp.body != `{"error":"missing or unknown API key"}` {
			t.Errorf("token %q: body %s", token, resp.body)
		}
	}
	if n := len(store.calls()); n != 0 {
		t.Errorf("%d inserts from unauthenticated posts", n)
	}
}

func TestChangesRefusesAnythingButJSON(t *testing.T) {
	store := &fakeChangeStore{id: "chg_0000000000000001"}
	srv, meter := changesServer(t, store)
	cases := []struct{ name, contentType string }{
		{"protobuf", "application/x-protobuf"},
		{"text", "text/plain"},
		{"none", ""},
		{"unreadable", "application/"},
	}
	for _, tc := range cases {
		resp := postChange(t, srv, testKey, tc.contentType, validChange)
		if resp.status != http.StatusUnsupportedMediaType || !strings.Contains(resp.body, "application/json") {
			t.Errorf("%s: status %d body %s", tc.name, resp.status, resp.body)
		}
	}
	resp := postChange(t, srv, testKey, "application/json", validChange, "Content-Encoding", "gzip")
	if resp.status != http.StatusUnsupportedMediaType || !strings.Contains(resp.body, "Content-Encoding") {
		t.Errorf("gzip: status %d body %s", resp.status, resp.body)
	}
	if n := len(store.calls()); n != 0 {
		t.Errorf("%d inserts from refused media types", n)
	}
	dropped := meter.droppedCalls()
	if len(dropped) != len(cases)+1 {
		t.Fatalf("dropped calls = %d, want %d", len(dropped), len(cases)+1)
	}
	for _, d := range dropped {
		if d.reason != metering.DropUnsupported || d.records != 1 || d.workspaceID != workspaceID {
			t.Errorf("drop = %+v, want unsupported x1 for %s", d, workspaceID)
		}
	}
}

func TestChangesCapsTheBodyAt64KiB(t *testing.T) {
	store := &fakeChangeStore{id: "chg_0000000000000001"}
	srv, meter := changesServer(t, store)
	huge := `{"kind":"deploy","title":"x","detail":"` + strings.Repeat("a", 64<<10) + `"}`
	resp := postChange(t, srv, testKey, "application/json", huge)
	if resp.status != http.StatusRequestEntityTooLarge || !strings.Contains(resp.body, "64KiB") {
		t.Errorf("status %d body %s", resp.status, resp.body)
	}
	if n := len(store.calls()); n != 0 {
		t.Errorf("%d inserts from an over-cap body", n)
	}
	if d := meter.droppedCalls(); len(d) != 1 || d[0].reason != metering.DropDecode {
		t.Errorf("dropped = %+v, want one decode drop", d)
	}
}

func TestChangesRefusesAnInvalidDocumentWithTheFieldNamed(t *testing.T) {
	store := &fakeChangeStore{id: "chg_0000000000000001"}
	srv, meter := changesServer(t, store)
	cases := []struct{ name, body, want string }{
		{"the body cannot name a workspace", `{"kind":"deploy","title":"x","workspace_id":"ws_bob"}`, `{"error":"workspace_id: unknown field"}`},
		{"the body cannot name a key", `{"kind":"deploy","title":"x","key_id":"k"}`, `{"error":"key_id: unknown field"}`},
		{"bad kind", `{"kind":"release","title":"x"}`, `kind: `},
		{"javascript link", `{"kind":"deploy","title":"x","link":{"label":"x","href":"javascript:alert(1)"}}`, `link.href: `},
		{"array", `[]`, `body: `},
		{"malformed", `{"kind":`, `body: `},
	}
	for _, tc := range cases {
		resp := postChange(t, srv, testKey, "application/json", tc.body)
		if resp.status != http.StatusBadRequest || !strings.Contains(resp.body, tc.want) {
			t.Errorf("%s: status %d body %s (want 400 containing %q)", tc.name, resp.status, resp.body, tc.want)
		}
	}
	if n := len(store.calls()); n != 0 {
		t.Errorf("%d inserts from refused documents", n)
	}
	dropped := meter.droppedCalls()
	if len(dropped) != len(cases) {
		t.Fatalf("dropped calls = %d, want %d", len(dropped), len(cases))
	}
	for _, d := range dropped {
		if d.reason != metering.DropDecode || d.records != 1 {
			t.Errorf("drop = %+v, want decode x1", d)
		}
	}
	if n := len(meter.acceptedChangeCalls()); n != 0 {
		t.Errorf("%d accepted-change health records from refusals", n)
	}
}

func TestChangesInsertsUnderTheCredentialsWorkspace(t *testing.T) {
	store := &fakeChangeStore{id: "chg_00000000000000aa"}
	srv, meter := changesServer(t, store)
	resp := postChange(t, srv, testKey, "application/json", validChange)
	if resp.status != http.StatusCreated {
		t.Fatalf("status %d body %s", resp.status, resp.body)
	}
	if resp.headers.Get("Content-Type") != "application/json" {
		t.Errorf("Content-Type = %q", resp.headers.Get("Content-Type"))
	}
	var answer struct {
		ID           string `json:"id"`
		Deduplicated bool   `json:"deduplicated"`
	}
	if err := json.Unmarshal([]byte(resp.body), &answer); err != nil || answer.ID != "chg_00000000000000aa" || answer.Deduplicated {
		t.Errorf("body %s (err %v)", resp.body, err)
	}
	calls := store.calls()
	if len(calls) != 1 {
		t.Fatalf("inserts = %d, want 1", len(calls))
	}
	if calls[0].identity.WorkspaceID != workspaceID || calls[0].identity.KeyID != "key_"+workspaceID {
		t.Errorf("insert identity = %+v, want the credential's", calls[0].identity)
	}
	ev := calls[0].event
	if ev.Kind != "deploy" || ev.Title != "deploy 8963ae2" || ev.Service == nil || *ev.Service != "checkout" || ev.ExternalID == nil || *ev.ExternalID != "run:1" {
		t.Errorf("event = %+v", ev)
	}
	accepted := meter.acceptedChangeCalls()
	if len(accepted) != 1 || accepted[0].workspaceID != workspaceID || accepted[0].keyID != "key_"+workspaceID {
		t.Errorf("accepted-change health = %+v", accepted)
	}
	if n := len(meter.droppedCalls()); n != 0 {
		t.Errorf("%d drops from an accepted post", n)
	}
}

func TestChangesAnswersADuplicateWithTheOriginalId(t *testing.T) {
	store := &fakeChangeStore{id: "chg_0000000000000f1r", dedup: true}
	srv, meter := changesServer(t, store)
	resp := postChange(t, srv, testKey, "application/json", validChange)
	if resp.status != http.StatusOK || resp.body != `{"id":"chg_0000000000000f1r","deduplicated":true}` {
		t.Errorf("status %d body %s", resp.status, resp.body)
	}
	if n := len(meter.acceptedChangeCalls()); n != 0 {
		t.Errorf("a deduplicated post counted as accepted (%d)", n)
	}
}

func TestChangesAnswers503WhenStorageFails(t *testing.T) {
	store := &fakeChangeStore{err: errors.New("connection refused")}
	srv, meter := changesServer(t, store)
	resp := postChange(t, srv, testKey, "application/json", validChange)
	if resp.status != http.StatusServiceUnavailable || resp.body != `{"error":"storage unavailable"}` {
		t.Errorf("status %d body %s", resp.status, resp.body)
	}
	if n := len(meter.acceptedChangeCalls()); n != 0 {
		t.Errorf("a failed write counted as accepted (%d)", n)
	}
}

func TestChangesAnswers401WhenTheCredentialIsGone(t *testing.T) {
	store := &fakeChangeStore{err: changes.ErrUnknownKey}
	srv, _ := changesServer(t, store)
	resp := postChange(t, srv, testKey, "application/json", validChange)
	if resp.status != http.StatusUnauthorized || resp.body != `{"error":"missing or unknown API key"}` {
		t.Errorf("status %d body %s", resp.status, resp.body)
	}
}

func TestChangesPanicAnswersInJSON(t *testing.T) {
	store := &fakeChangeStore{panics: true}
	srv, _ := changesServer(t, store)
	resp := postChange(t, srv, testKey, "application/json", validChange)
	if resp.status != http.StatusInternalServerError || resp.body != `{"error":"internal error handling delivery"}` {
		t.Errorf("status %d body %s", resp.status, resp.body)
	}
}

func TestChangesRateCapIsPerWorkspace(t *testing.T) {
	store := &fakeChangeStore{id: "chg_0000000000000001"}
	srv, meter := changesServer(t, store)
	for i := 0; i < 60; i++ {
		if resp := postChange(t, srv, testKey, "application/json", validChange); resp.status != http.StatusCreated {
			t.Fatalf("post %d: status %d body %s", i+1, resp.status, resp.body)
		}
	}
	resp := postChange(t, srv, testKey, "application/json", validChange)
	if resp.status != http.StatusTooManyRequests || resp.headers.Get("Retry-After") != "60" ||
		resp.body != `{"error":"change events are capped at 60 per minute per workspace"}` {
		t.Errorf("61st post: status %d Retry-After %q body %s", resp.status, resp.headers.Get("Retry-After"), resp.body)
	}
	// Another workspace is untouched by the first one's cap.
	if resp := postChange(t, srv, "bob-key", "application/json", validChange); resp.status != http.StatusCreated {
		t.Errorf("bob's first post: status %d body %s", resp.status, resp.body)
	}
	// A refused post is not a drop in the health row: nothing was decoded
	// or written, and the counter for it is the ops one.
	if n := len(meter.droppedCalls()); n != 0 {
		t.Errorf("%d health drops from the rate cap", n)
	}
	if n := len(store.calls()); n != 61 {
		t.Errorf("inserts = %d, want 61 (60 alice + 1 bob)", n)
	}
}

// droppedCalls lists every health drop the meter saw, in order — the changes
// tests assert the exact reason and count per refusal, not a sum.
func (m *fakeMeter) droppedCalls() []droppedCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]droppedCall(nil), m.dropped...)
}
