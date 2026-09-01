package changes

import (
	"strings"
	"testing"
	"time"
)

var testNow = time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)

func str(s string) *string { return &s }

func TestParseAcceptsTheRecipeDocument(t *testing.T) {
	body := `{"kind":"deploy","service":"checkout","ref":"8963ae2","title":"deploy 8963ae2","who":"ziad",` +
		`"source":"github-actions","external_id":"github:o/r:run:1:1",` +
		`"link":{"label":"workflow run","href":"https://github.com/o/r/actions/runs/1"}}`
	ev, ref := Parse([]byte(body), testNow)
	if ref != nil {
		t.Fatalf("refused: %v", ref)
	}
	if ev.Kind != "deploy" || ev.Title != "deploy 8963ae2" || ev.Who != "ziad" || ev.Detail != "" {
		t.Errorf("scalar fields = %q %q %q %q", ev.Kind, ev.Title, ev.Who, ev.Detail)
	}
	if ev.Service == nil || *ev.Service != "checkout" || ev.Ref == nil || *ev.Ref != "8963ae2" ||
		ev.Source == nil || *ev.Source != "github-actions" || ev.ExternalID == nil || *ev.ExternalID != "github:o/r:run:1:1" {
		t.Errorf("optional fields not carried: %+v", ev)
	}
	if ev.Link == nil || ev.Link.Label != "workflow run" || ev.Link.Href != "https://github.com/o/r/actions/runs/1" {
		t.Errorf("link = %+v", ev.Link)
	}
	if !ev.At.Equal(testNow) {
		t.Errorf("at defaulted to %v, want the server's now %v", ev.At, testNow)
	}
}

func TestParseMinimalDocument(t *testing.T) {
	ev, ref := Parse([]byte(`{"kind":"config","title":"x"}`), testNow)
	if ref != nil {
		t.Fatalf("refused: %v", ref)
	}
	if ev.Service != nil || ev.Ref != nil || ev.Source != nil || ev.ExternalID != nil || ev.Link != nil {
		t.Errorf("absent optionals must be nil: %+v", ev)
	}
	if ev.Who != "" || ev.Detail != "" || !ev.At.Equal(testNow) {
		t.Errorf("defaults: who=%q detail=%q at=%v", ev.Who, ev.Detail, ev.At)
	}
}

func TestParseKeepsAtAndNormalisesToUTC(t *testing.T) {
	ev, ref := Parse([]byte(`{"kind":"scale","title":"x","at":"2026-09-02T11:00:00+02:00"}`), testNow)
	if ref != nil {
		t.Fatalf("refused: %v", ref)
	}
	want := time.Date(2026, 9, 2, 9, 0, 0, 0, time.UTC)
	if !ev.At.Equal(want) || ev.At.Location() != time.UTC {
		t.Errorf("at = %v (%v), want %v UTC", ev.At, ev.At.Location(), want)
	}
	// A backfill is honest history: any past time is accepted.
	if _, ref := Parse([]byte(`{"kind":"scale","title":"x","at":"2020-01-01T00:00:00Z"}`), testNow); ref != nil {
		t.Errorf("a past at was refused: %v", ref)
	}
	// Just inside the skew allowance is accepted.
	nearFuture := testNow.Add(4*time.Minute + 59*time.Second).Format(time.RFC3339)
	if _, ref := Parse([]byte(`{"kind":"scale","title":"x","at":"`+nearFuture+`"}`), testNow); ref != nil {
		t.Errorf("an at inside the 5 minute allowance was refused: %v", ref)
	}
}

func TestParseTrimsAndTreatsEmptyOptionalsAsAbsent(t *testing.T) {
	ev, ref := Parse([]byte(`{"kind":"flag","title":"  t  ","service":"  ","external_id":"","ref":null,"link":null,"detail":"a\nb"}`), testNow)
	if ref != nil {
		t.Fatalf("refused: %v", ref)
	}
	if ev.Title != "t" {
		t.Errorf("title not trimmed: %q", ev.Title)
	}
	if ev.Service != nil || ev.ExternalID != nil || ev.Ref != nil || ev.Link != nil {
		t.Errorf("blank/null optionals must be nil: %+v", ev)
	}
	if ev.Detail != "a\nb" {
		t.Errorf("a newline in detail is allowed; got %q", ev.Detail)
	}
}

func TestParseRefusals(t *testing.T) {
	long := func(n int) string { return strings.Repeat("x", n) }
	future := testNow.Add(6 * time.Minute).Format(time.RFC3339)
	cases := []struct {
		name, body, field, reason string
		kind                      RefusalKind
	}{
		{"array body", `[{"kind":"deploy","title":"x"}]`, "body", "JSON object", RefusedDecode},
		{"malformed", `{"kind":`, "body", "malformed", RefusedDecode},
		{"trailing data", `{"kind":"deploy","title":"x"} {}`, "body", "trailing", RefusedDecode},
		{"empty body", ``, "body", "malformed", RefusedDecode},
		{"unknown field", `{"kind":"deploy","title":"x","workspace_id":"ws_b"}`, "workspace_id", "unknown field", RefusedInvalid},
		{"key_id is not the client's to name", `{"kind":"deploy","title":"x","key_id":"k"}`, "key_id", "unknown field", RefusedInvalid},
		{"wrong type", `{"kind":"deploy","title":5}`, "title", "string", RefusedInvalid},
		{"missing kind", `{"title":"x"}`, "kind", "one of", RefusedInvalid},
		{"bad kind", `{"kind":"release","title":"x"}`, "kind", "one of", RefusedInvalid},
		{"empty title", `{"kind":"deploy","title":"   "}`, "title", "empty", RefusedInvalid},
		{"long title", `{"kind":"deploy","title":"` + long(201) + `"}`, "title", "200", RefusedInvalid},
		{"long detail", `{"kind":"deploy","title":"x","detail":"` + long(2001) + `"}`, "detail", "2000", RefusedInvalid},
		{"control char in title", `{"kind":"deploy","title":"a\u0007b"}`, "title", "control", RefusedInvalid},
		{"newline in title", `{"kind":"deploy","title":"a\nb"}`, "title", "control", RefusedInvalid},
		{"long who", `{"kind":"deploy","title":"x","who":"` + long(121) + `"}`, "who", "120", RefusedInvalid},
		{"long service", `{"kind":"deploy","title":"x","service":"` + long(121) + `"}`, "service", "120", RefusedInvalid},
		{"long ref", `{"kind":"deploy","title":"x","ref":"` + long(129) + `"}`, "ref", "128", RefusedInvalid},
		{"long source", `{"kind":"deploy","title":"x","source":"` + long(61) + `"}`, "source", "60", RefusedInvalid},
		{"long external_id", `{"kind":"deploy","title":"x","external_id":"` + long(201) + `"}`, "external_id", "200", RefusedInvalid},
		{"future at", `{"kind":"deploy","title":"x","at":"` + future + `"}`, "at", "future", RefusedInvalid},
		{"unparseable at", `{"kind":"deploy","title":"x","at":"yesterday"}`, "at", "RFC 3339", RefusedInvalid},
		{"link without href", `{"kind":"deploy","title":"x","link":{"label":"x"}}`, "link.href", "absolute", RefusedInvalid},
		{"link without label", `{"kind":"deploy","title":"x","link":{"href":"https://a.b/c"}}`, "link.label", "empty", RefusedInvalid},
		{"javascript href", `{"kind":"deploy","title":"x","link":{"label":"x","href":"javascript:alert(1)"}}`, "link.href", "http", RefusedInvalid},
		{"data href", `{"kind":"deploy","title":"x","link":{"label":"x","href":"data:text/html,hi"}}`, "link.href", "http", RefusedInvalid},
		{"relative href", `{"kind":"deploy","title":"x","link":{"label":"x","href":"/app/incidents"}}`, "link.href", "absolute", RefusedInvalid},
		{"long href", `{"kind":"deploy","title":"x","link":{"label":"x","href":"https://a.b/` + long(2048) + `"}}`, "link.href", "2048", RefusedInvalid},
		{"long label", `{"kind":"deploy","title":"x","link":{"label":"` + long(61) + `","href":"https://a.b/c"}}`, "link.label", "60", RefusedInvalid},
		{"unknown link field", `{"kind":"deploy","title":"x","link":{"label":"x","href":"https://a.b/c","rel":"x"}}`, "rel", "unknown field", RefusedInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, ref := Parse([]byte(tc.body), testNow)
			if ref == nil {
				t.Fatalf("accepted %s", tc.body)
			}
			if ref.Field != tc.field || !strings.Contains(ref.Reason, tc.reason) || ref.Kind != tc.kind {
				t.Errorf("refusal = {%q %q %v}, want field %q reason containing %q kind %v", ref.Field, ref.Reason, ref.Kind, tc.field, tc.reason, tc.kind)
			}
			if got, want := ref.Error(), tc.field+": "+ref.Reason; got != want {
				t.Errorf("Error() = %q, want %q", got, want)
			}
		})
	}
}

func TestParseRefusesInvalidUTF8(t *testing.T) {
	body := append([]byte(`{"kind":"deploy","title":"a`), 0xff, 'b', '"', '}')
	_, ref := Parse(body, testNow)
	if ref == nil {
		t.Fatal("accepted a title that is not valid UTF-8")
	}
	// The decoder would have laundered the byte into U+FFFD before any field
	// check ran, so the refusal is the body's: not a document at all.
	if ref.Field != "body" || !strings.Contains(ref.Reason, "UTF-8") || ref.Kind != RefusedDecode {
		t.Errorf("refusal = %v", ref)
	}
}

func TestLengthsCountCharactersNotBytes(t *testing.T) {
	// 200 two-byte characters is 400 bytes and exactly the limit — the DDL's
	// char_length counts characters, so the validator must too.
	title := strings.Repeat("é", 200)
	if _, ref := Parse([]byte(`{"kind":"deploy","title":"`+title+`"}`), testNow); ref != nil {
		t.Errorf("200 multibyte characters refused: %v", ref)
	}
	if _, ref := Parse([]byte(`{"kind":"deploy","title":"`+title+`é"}`), testNow); ref == nil {
		t.Error("201 characters accepted")
	}
}
