package notify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Channel kinds, the D486 vocabulary. Both are one HTTPS POST; they differ only
// in the document that goes in the body, which is why the kind lives here rather
// than in the transport.
const (
	// KindWebhook receives the versioned JSON document below.
	KindWebhook = "webhook"
	// KindSlackWebhook receives Slack's `{"text": …}` — the versioned document
	// would render in a channel as a wall of braces.
	KindSlackWebhook = "slack_webhook"
)

// PayloadVersion is the version stamped on every generic webhook document.
//
// The document EVOLVES BY ADDITION ONLY: a field may be added at any time, and
// an existing field never changes name, type or meaning and is never removed.
// A receiver written against version 1 therefore keeps working forever, and this
// constant only moves if that promise is ever deliberately broken — at which
// point it is a breaking change with a number attached rather than a silent one.
const PayloadVersion = 1

// Payload is what a `webhook` channel receives: the alert, in full, as JSON.
// For a `slack_webhook` channel the same struct is the SOURCE of the `{text}`
// body rather than the body itself.
//
// Shapes are deliberately minimal. Everything here is either already visible to
// the customer in the product or is the reason they were paged; nothing about
// obstack's internals, and no identifier a receiver could not have gotten from
// the link, goes over a wire we do not control.
type Payload struct {
	// Version is PayloadVersion. First field so a receiver can branch on it
	// before reading anything else.
	Version int `json:"version"`
	// Rule is the rule that fired, or nil for a rule-less event — D491's test
	// notification is the one that exists. A rule of empty strings would be a
	// severity we invented, so the absence is spelled `null`.
	Rule *RulePayload `json:"rule"`
	// Event is the thing that happened.
	Event EventPayload `json:"event"`
	// Workspace is the workspace id the rule and event belong to.
	Workspace string `json:"workspace"`
}

// RulePayload is the rule as its author wrote it.
type RulePayload struct {
	// Name is the rule's name, unique within the workspace.
	Name string `json:"name"`
	// Severity is the RULE's severity — critical, warning or info (D484: the
	// author decides how loud, not the event).
	Severity string `json:"severity"`
	// Condition is the human-readable rendering of the structured condition,
	// produced by the one shared formatter (D481). It is presentation: it is
	// rendered, never stored and never parsed, here or anywhere.
	Condition string `json:"condition"`
}

// EventPayload is the state transition that produced this delivery.
type EventPayload struct {
	// Title is the one-line summary, as it appears in the events feed.
	Title string `json:"title"`
	// Detail is the sentence under it — what the value was and what it crossed.
	Detail string `json:"detail"`
	// Link points back into the product, or is empty when the event has none.
	// The key is always present: a versioned document does not drop keys.
	Link string `json:"link"`
	// At is when the event was emitted, RFC 3339 in UTC.
	At time.Time `json:"at"`
}

// slackBody is Slack's incoming-webhook shape, and all of it we use.
type slackBody struct {
	Text string `json:"text"`
}

// encodeBody renders the body for one channel kind. An unknown kind is a bug in
// the caller and returns an error rather than a guess — inventing a body for a
// channel we do not understand is how a customer's alert ends up somewhere they
// did not agree to.
func encodeBody(kind string, p Payload) ([]byte, error) {
	switch kind {
	case KindWebhook:
		return marshal(p)
	case KindSlackWebhook:
		return marshal(slackBody{Text: slackText(p.Event)})
	default:
		return nil, fmt.Errorf("notify: unknown channel kind %q", kind)
	}
}

// marshal writes compact JSON with Go's HTML escaping turned OFF. These bodies
// are read by JSON parsers, never embedded in a page, and the escaping that
// actually matters here — Slack's markup — is done explicitly below. Leaving it
// on would render every `<link>` as `<link>` for no gain.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, fmt.Errorf("notify: encode body: %w", err)
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// slackText composes the `{text}` body from title, detail and link.
//
// Title and detail are escaped for Slack's mrkdwn before they go in. They are
// derived from things a customer's telemetry named — a service, a metric label —
// so an unescaped title could forge a link or bold the rest of the message in
// somebody's incident channel. The link is the one part we wrote, so it keeps
// Slack's `<url>` form.
func slackText(e EventPayload) string {
	var b strings.Builder
	b.WriteString("*")
	b.WriteString(escapeMrkdwn(e.Title))
	b.WriteString("*")
	if e.Detail != "" {
		b.WriteString("\n")
		b.WriteString(escapeMrkdwn(e.Detail))
	}
	if e.Link != "" {
		b.WriteString("\n<")
		b.WriteString(e.Link)
		b.WriteString(">")
	}
	return b.String()
}

// escapeMrkdwn applies Slack's three required escapes in one pass, so an
// ampersand produced by escaping a bracket is not escaped again.
func escapeMrkdwn(s string) string {
	return mrkdwnEscaper.Replace(s)
}

var mrkdwnEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
