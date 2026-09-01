// Package changes is the change-event ingest (S7.2 packet, D493–D499): the
// document POST /v1/changes accepts, the row it becomes, and the per-workspace
// guard in front of it. The HTTP glue lives in internal/receive beside the
// other bearer-authenticated routes; this package holds what can be proven
// without a listener.
package changes

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// The six kinds, verbatim from the mock (packet §0). This is the Go side of a
// vocabulary that also exists in apps/web/src/lib/change-types.ts; the D499
// source-parsing test pins the two (and the docs table) to each other.
var kinds = []string{"deploy", "config", "scale", "secret", "flag", "infra"}

// The DDL's limits (0011_change_events.sql), repeated here so a document is
// refused with its field named before a CHECK could turn into a 500. Lengths
// are in characters — char_length's unit — not bytes.
const (
	maxTitle      = 200
	maxDetail     = 2000
	maxWho        = 120
	maxService    = 120
	maxRef        = 128
	maxSource     = 60
	maxLinkLabel  = 60
	maxLinkHref   = 2048
	maxExternalID = 200

	// futureAllowance is how far ahead of the server's clock a client-supplied
	// `at` may sit: clock skew, not scheduling. Any past time is accepted — a
	// backfill is honest history.
	futureAllowance = 5 * time.Minute
)

// RefusalKind separates a body that could not be read as JSON (decode) from a
// well-formed document outside the contract (invalid). The ops counter is
// labelled with it; both are a 400 and a dropped_decode on the key's health
// row (D497).
type RefusalKind string

const (
	RefusedDecode  RefusalKind = "decode"
	RefusedInvalid RefusalKind = "invalid"
)

// Refusal names the field and the reason, and renders as "<field>: <reason>" —
// the 400 body's one sentence (D499). Field is "body" when no field can be
// blamed.
type Refusal struct {
	Field  string
	Reason string
	Kind   RefusalKind
}

func (r *Refusal) Error() string { return r.Field + ": " + r.Reason }

// Link is an outbound reference into the source system — a workflow run, a
// commit. It is never a product-internal route (packet §0).
type Link struct {
	Label string `json:"label"`
	Href  string `json:"href"`
}

// Event is a validated, normalised document: what the store writes. Optional
// strings are nil when absent or blank — the row's NULL — never "".
type Event struct {
	Kind, Title, Detail, Who         string
	Service, Ref, Source, ExternalID *string
	Link                             *Link
	// At is the event's own time in UTC: the client's, or the server's now.
	At time.Time
}

// document is the wire shape (D499). Every field the client may send is here
// and nothing else: the decoder refuses unknown fields, which is how the body
// is kept from naming a workspace or a key.
type document struct {
	Kind       *string `json:"kind"`
	Title      *string `json:"title"`
	Detail     *string `json:"detail"`
	Who        *string `json:"who"`
	Service    *string `json:"service"`
	Ref        *string `json:"ref"`
	Source     *string `json:"source"`
	At         *string `json:"at"`
	Link       *link   `json:"link"`
	ExternalID *string `json:"external_id"`
}

type link struct {
	Label *string `json:"label"`
	Href  *string `json:"href"`
}

// Parse decodes and validates one document against the contract. now is the
// server's clock: the default for `at` and the reference for the skew check.
func Parse(body []byte, now time.Time) (Event, *Refusal) {
	var d document
	if ref := decodeStrict(body, &d); ref != nil {
		return Event{}, ref
	}

	var ev Event
	var ref *Refusal

	// Required.
	kind, ref := requiredString("kind", d.Kind, 0)
	if ref != nil {
		return Event{}, ref
	}
	if !contains(kinds, kind) {
		return Event{}, invalid("kind", "must be one of "+strings.Join(kinds, ", "))
	}
	ev.Kind = kind
	if ev.Title, ref = requiredString("title", d.Title, maxTitle); ref != nil {
		return Event{}, ref
	}

	// Optional scalars with a NOT NULL DEFAULT '' column.
	if ev.Detail, ref = optionalText("detail", d.Detail, maxDetail, true); ref != nil {
		return Event{}, ref
	}
	if ev.Who, ref = optionalText("who", d.Who, maxWho, false); ref != nil {
		return Event{}, ref
	}

	// Optional scalars with a NULL column: blank is absent.
	if ev.Service, ref = optionalNullable("service", d.Service, maxService); ref != nil {
		return Event{}, ref
	}
	if ev.Ref, ref = optionalNullable("ref", d.Ref, maxRef); ref != nil {
		return Event{}, ref
	}
	if ev.Source, ref = optionalNullable("source", d.Source, maxSource); ref != nil {
		return Event{}, ref
	}
	if ev.ExternalID, ref = optionalNullable("external_id", d.ExternalID, maxExternalID); ref != nil {
		return Event{}, ref
	}

	if ev.At, ref = parseAt(d.At, now); ref != nil {
		return Event{}, ref
	}
	if ev.Link, ref = parseLink(d.Link); ref != nil {
		return Event{}, ref
	}
	return ev, nil
}

// decodeStrict reads exactly one JSON object with no unknown fields and
// nothing after it. The first strict decoder in the service, by design (D499):
// the integration routes decode third parties' payloads permissively; this is
// our own contract, and a misspelled field in a CI recipe silently dropping the
// deploy's service is the failure a write API must not have.
func decodeStrict(body []byte, into *document) *Refusal {
	// encoding/json swaps invalid UTF-8 for U+FFFD while decoding rather than
	// failing, so the bytes are checked before the decoder can launder them —
	// JSON text is UTF-8 by definition (RFC 8259 §8.1), and a body that is not
	// is not a document.
	if !utf8.Valid(body) {
		return &Refusal{Field: "body", Reason: "must be valid UTF-8", Kind: RefusedDecode}
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		var typeErr *json.UnmarshalTypeError
		switch {
		case errors.As(err, &typeErr):
			if typeErr.Field == "" {
				// The top-level value is not an object (an array, a string…).
				return &Refusal{Field: "body", Reason: "expected a JSON object", Kind: RefusedDecode}
			}
			return invalid(typeErr.Field, "expected a "+expectedType(typeErr))
		case strings.HasPrefix(err.Error(), "json: unknown field "):
			name := strings.Trim(strings.TrimPrefix(err.Error(), "json: unknown field "), `"`)
			return invalid(name, "unknown field")
		default:
			return &Refusal{Field: "body", Reason: "malformed JSON", Kind: RefusedDecode}
		}
	}
	// Anything after the object — a second document, a stray brace — is a
	// body we did not read whole, so it is not a body we accept.
	if _, err := dec.Token(); err != io.EOF {
		return &Refusal{Field: "body", Reason: "trailing data after the JSON object", Kind: RefusedDecode}
	}
	return nil
}

// expectedType names what a field should have been in the caller's terms:
// every field here is a string, except link which is an object.
func expectedType(e *json.UnmarshalTypeError) string {
	if e.Field == "link" {
		return "JSON object"
	}
	return "string"
}

func invalid(field, reason string) *Refusal {
	return &Refusal{Field: field, Reason: reason, Kind: RefusedInvalid}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// checkText is the one rule every string field goes through: valid UTF-8,
// no control characters (a newline only where allowNewline says so — detail),
// and at most limit characters. limit 0 means unbounded.
func checkText(field, s string, limit int, allowNewline bool) *Refusal {
	if !utf8.ValidString(s) {
		return invalid(field, "must be valid UTF-8")
	}
	for _, r := range s {
		if r == '\n' && allowNewline {
			continue
		}
		if r < 0x20 || r == 0x7f {
			return invalid(field, "must not contain control characters")
		}
	}
	if limit > 0 && utf8.RuneCountInString(s) > limit {
		return invalid(field, fmt.Sprintf("must be at most %d characters", limit))
	}
	return nil
}

func requiredString(field string, v *string, limit int) (string, *Refusal) {
	if v == nil {
		if field == "kind" {
			return "", invalid(field, "must be one of "+strings.Join(kinds, ", "))
		}
		return "", invalid(field, "must not be empty")
	}
	s := strings.TrimSpace(*v)
	if s == "" {
		if field == "kind" {
			return "", invalid(field, "must be one of "+strings.Join(kinds, ", "))
		}
		return "", invalid(field, "must not be empty")
	}
	if ref := checkText(field, s, limit, false); ref != nil {
		return "", ref
	}
	return s, nil
}

func optionalText(field string, v *string, limit int, allowNewline bool) (string, *Refusal) {
	if v == nil {
		return "", nil
	}
	s := strings.TrimSpace(*v)
	if ref := checkText(field, s, limit, allowNewline); ref != nil {
		return "", ref
	}
	return s, nil
}

func optionalNullable(field string, v *string, limit int) (*string, *Refusal) {
	if v == nil {
		return nil, nil
	}
	s := strings.TrimSpace(*v)
	if s == "" {
		return nil, nil
	}
	if ref := checkText(field, s, limit, false); ref != nil {
		return nil, ref
	}
	return &s, nil
}

func parseAt(v *string, now time.Time) (time.Time, *Refusal) {
	if v == nil || strings.TrimSpace(*v) == "" {
		return now.UTC(), nil
	}
	t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(*v))
	if err != nil {
		return time.Time{}, invalid("at", "must be an RFC 3339 timestamp")
	}
	if t.After(now.Add(futureAllowance)) {
		return time.Time{}, invalid("at", "must not be more than 5 minutes in the future")
	}
	return t.UTC(), nil
}

// parseLink: both halves or neither. The href must be an absolute http(s) URL
// — it is rendered as an anchor, and a `javascript:` or `data:` scheme must
// never reach a DOM (D499). Field names are dotted so the 400 says exactly
// which half is wrong.
func parseLink(l *link) (*Link, *Refusal) {
	if l == nil {
		return nil, nil
	}
	label := ""
	if l.Label != nil {
		label = strings.TrimSpace(*l.Label)
	}
	href := ""
	if l.Href != nil {
		href = strings.TrimSpace(*l.Href)
	}
	if label == "" && href == "" {
		return nil, nil
	}
	if label == "" {
		return nil, invalid("link.label", "must not be empty when a link is given")
	}
	if ref := checkText("link.label", label, maxLinkLabel, false); ref != nil {
		return nil, ref
	}
	if ref := checkText("link.href", href, maxLinkHref, false); ref != nil {
		return nil, ref
	}
	u, err := url.Parse(href)
	if err != nil || !u.IsAbs() || u.Host == "" {
		return nil, invalid("link.href", "must be an absolute http or https URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, invalid("link.href", "must use http or https")
	}
	return &Link{Label: label, Href: href}, nil
}
