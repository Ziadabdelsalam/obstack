package notify

import (
	"testing"
	"time"
)

// (5a) The `webhook` document, byte for byte. This is a wire contract with
// receivers we do not control, so the golden is exact bytes rather than a
// round-trip: a renamed field, a dropped key or a changed time format is a
// breaking change for somebody's integration, and it should have to be typed
// into this file deliberately.
func TestWebhookPayloadGolden(t *testing.T) {
	got, err := encodeBody(KindWebhook, samplePayload())
	if err != nil {
		t.Fatalf("encodeBody: %v", err)
	}
	const want = `{"version":1,"rule":{"name":"Checkout error rate","severity":"critical",` +
		`"condition":"error rate over 5m is above 5%"},"slo":null,` +
		`"event":{"title":"Checkout error rate is firing",` +
		`"detail":"error rate over 5m is 12.4%, above 5%",` +
		`"link":"https://obstack.example/app/alerts","at":"2026-09-02T14:30:00Z"},` +
		`"workspace":"ws_acme"}`
	if string(got) != want {
		t.Errorf("webhook body:\n got %s\nwant %s", got, want)
	}
}

// (5b) The `slack_webhook` body is a different document entirely — Slack wants
// `{text}` and would render the versioned JSON as a wall of braces.
func TestSlackPayloadGolden(t *testing.T) {
	got, err := encodeBody(KindSlackWebhook, samplePayload())
	if err != nil {
		t.Fatalf("encodeBody: %v", err)
	}
	const want = `{"text":"*Checkout error rate is firing*\n` +
		`error rate over 5m is 12.4%, above 5%\n` +
		`<https://obstack.example/app/alerts>"}`
	if string(got) != want {
		t.Errorf("slack body:\n got %s\nwant %s", got, want)
	}
}

// A rule-less event (D491's test notification) says so with a null rule rather
// than a rule of empty strings. An empty-string severity on the wire would be a
// fact we made up.
func TestRuleLessPayloadEmitsNullRule(t *testing.T) {
	p := samplePayload()
	p.Rule = nil
	p.Event.Title = "Test notification"
	p.Event.Detail = "Sent from obstack to prove this channel works."
	p.Event.Link = ""

	got, err := encodeBody(KindWebhook, p)
	if err != nil {
		t.Fatalf("encodeBody: %v", err)
	}
	const want = `{"version":1,"rule":null,"slo":null,` +
		`"event":{"title":"Test notification","detail":"Sent from obstack to prove this channel works.",` +
		`"link":"","at":"2026-09-02T14:30:00Z"},"workspace":"ws_acme"}`
	if string(got) != want {
		t.Errorf("rule-less body:\n got %s\nwant %s", got, want)
	}

	slack, err := encodeBody(KindSlackWebhook, p)
	if err != nil {
		t.Fatalf("encodeBody(slack): %v", err)
	}
	const wantSlack = `{"text":"*Test notification*\nSent from obstack to prove this channel works."}`
	if string(slack) != wantSlack {
		t.Errorf("rule-less slack body:\n got %s\nwant %s", slack, wantSlack)
	}
}

// S7.3 (D512): an SLO's transition names the SLO and leaves `rule` null — the
// key was ADDED at version 1 (additive evolution, the package's promise), so
// the golden moves once, here, deliberately.
func TestSloPayloadGolden(t *testing.T) {
	p := samplePayload()
	p.Rule = nil
	p.Slo = &SloPayload{Name: "API availability", Objective: "99.9% of traces without an error span over 30d · all services", Status: "breached"}
	p.Event.Title = "API availability: breached — 99.8% against a 99.9% target"
	p.Event.Detail = "99.9% of traces without an error span over 30d · all services: 99.8% over the last 30d (998 of 1,000 traces good); 200% of the error budget consumed."
	p.Event.Link = ""

	got, err := encodeBody(KindWebhook, p)
	if err != nil {
		t.Fatalf("encodeBody: %v", err)
	}
	const want = `{"version":1,"rule":null,` +
		`"slo":{"name":"API availability","objective":"99.9% of traces without an error span over 30d · all services","status":"breached"},` +
		`"event":{"title":"API availability: breached — 99.8% against a 99.9% target",` +
		`"detail":"99.9% of traces without an error span over 30d · all services: 99.8% over the last 30d (998 of 1,000 traces good); 200% of the error budget consumed.",` +
		`"link":"","at":"2026-09-02T14:30:00Z"},"workspace":"ws_acme"}`
	if string(got) != want {
		t.Errorf("slo body:\n got %s\nwant %s", got, want)
	}
}

// Slack's mrkdwn is markup, and an alert title is attacker-adjacent text (a
// service name, a metric label). Escaped, a title cannot forge a link or bold
// half the message.
func TestSlackTextEscapesMrkdwn(t *testing.T) {
	got := slackText(EventPayload{
		Title:  "svc <a & b> down",
		Detail: "click <https://evil.example|here>",
		Link:   "https://obstack.example/app/alerts",
		At:     time.Now(),
	})
	const want = "*svc &lt;a &amp; b&gt; down*\n" +
		"click &lt;https://evil.example|here&gt;\n" +
		"<https://obstack.example/app/alerts>"
	if got != want {
		t.Errorf("slackText:\n got %q\nwant %q", got, want)
	}
}

// An unknown kind is a bug in the caller, not a reason to invent a body.
func TestUnknownChannelKindRefused(t *testing.T) {
	if _, err := encodeBody("pagerduty", samplePayload()); err == nil {
		t.Fatal("encodeBody(pagerduty) returned no error")
	}
}
