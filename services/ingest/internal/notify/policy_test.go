package notify

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

// stubResolver stands in for DNS so the dial-time fence can be proven without
// /etc/hosts, a DNS server, or a name that has to keep resolving somewhere on
// the internet for the suite to stay honest. It records what it was asked for,
// which is how a test tells "refused by URL inspection" apart from "refused at
// dial time": only the dial path calls a resolver.
type stubResolver struct {
	hosts    map[string][]string
	lookedUp []string
}

func (r *stubResolver) lookup(_ context.Context, host string) ([]netip.Addr, error) {
	r.lookedUp = append(r.lookedUp, host)
	raw, ok := r.hosts[host]
	if !ok {
		return nil, fmt.Errorf("stub resolver: no such host %q", host)
	}
	out := make([]netip.Addr, 0, len(raw))
	for _, s := range raw {
		out = append(out, netip.MustParseAddr(s))
	}
	return out, nil
}

// strictWith is the DEFAULT policy (D492: env unset ⇒ strict) with DNS stubbed.
func strictWith(r *stubResolver) Policy {
	return Policy{resolve: r.lookup}
}

func samplePayload() Payload {
	return Payload{
		Version: PayloadVersion,
		Rule: &RulePayload{
			Name:      "Checkout error rate",
			Severity:  "critical",
			Condition: "error rate over 5m is above 5%",
		},
		Event: EventPayload{
			Title:  "Checkout error rate is firing",
			Detail: "error rate over 5m is 12.4%, above 5%",
			Link:   "https://obstack.example/app/alerts",
			At:     time.Date(2026, 9, 2, 14, 30, 0, 0, time.UTC),
		},
		Workspace: "ws_acme",
	}
}

// (1) Refusal one: a non-HTTPS scheme, under the default policy. A webhook
// target is a credential and the payload names a customer's incident; plaintext
// is not a thing the operator gets to opt into by typing a URL.
func TestDefaultPolicyRefusesNonHTTPSScheme(t *testing.T) {
	r := &stubResolver{hosts: map[string][]string{"hooks.example.com": {"93.184.216.34"}}}
	d := New(strictWith(r))

	err := d.Deliver(context.Background(), Delivery{
		ChannelKind: KindWebhook,
		Target:      "http://hooks.example.com/hook/abcd1234",
		Payload:     samplePayload(),
	})
	if !errors.Is(err, ErrRefused) {
		t.Fatalf("http:// target: got %v, want an ErrRefused", err)
	}
	if len(r.lookedUp) != 0 {
		t.Errorf("scheme refusal resolved %v; a refused scheme must never reach DNS", r.lookedUp)
	}
	// Other schemes are refused too, and always — the escape hatch relaxes
	// http, not file: or gopher:.
	for _, target := range []string{
		"file:///etc/passwd",
		"gopher://hooks.example.com/hook",
		"ftp://hooks.example.com/hook",
	} {
		if err := d.Deliver(context.Background(), Delivery{ChannelKind: KindWebhook, Target: target, Payload: samplePayload()}); !errors.Is(err, ErrRefused) {
			t.Errorf("%s: got %v, want an ErrRefused", target, err)
		}
		if err := (Policy{AllowPrivate: true}).checkTarget(target); !errors.Is(err, ErrRefused) {
			t.Errorf("%s under the relaxed policy: got %v, want an ErrRefused", target, err)
		}
	}
}

// (2) Refusal two: a literal IP for a host, under the default policy. Refused
// whether or not the address is public — a literal IP is how the address fence
// gets walked around, so the name requirement is the fence.
func TestDefaultPolicyRefusesLiteralIPHost(t *testing.T) {
	r := &stubResolver{hosts: map[string][]string{}}
	d := New(strictWith(r))

	for _, target := range []string{
		"https://169.254.169.254/latest/meta-data/iam/security-credentials",
		"https://127.0.0.1/hook/abcd1234",
		"https://10.0.0.7/hook/abcd1234",
		"https://93.184.216.34/hook/abcd1234", // public, still refused
		"https://[::1]/hook/abcd1234",
		"https://[fd00::1]/hook/abcd1234",
	} {
		err := d.Deliver(context.Background(), Delivery{ChannelKind: KindWebhook, Target: target, Payload: samplePayload()})
		if !errors.Is(err, ErrRefused) {
			t.Errorf("%s: got %v, want an ErrRefused", target, err)
		}
	}
	if len(r.lookedUp) != 0 {
		t.Errorf("literal-IP refusal resolved %v; there is nothing to resolve", r.lookedUp)
	}
}

// (3) Refusal three, and the one that matters most: a perfectly ordinary
// hostname over https, refused because of what it RESOLVES to. Nothing about
// the URL is suspicious, so a URL-inspecting fence passes it; only a check bound
// to the connection catches it.
func TestDefaultPolicyRefusesPrivateResolutionAtDialTime(t *testing.T) {
	for _, tc := range []struct {
		name string
		addr string
	}{
		{"cloud metadata", "169.254.169.254"},
		{"rfc1918", "10.1.2.3"},
		{"loopback", "127.0.0.1"},
		{"ipv6 link-local", "fe80::1"},
		{"ipv6 unique-local", "fd12:3456::1"},
		{"unspecified", "0.0.0.0"},
		{"multicast", "224.0.0.1"},
		{"ipv4-mapped metadata", "::ffff:169.254.169.254"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &stubResolver{hosts: map[string][]string{"evil.test": {tc.addr}}}
			d := New(strictWith(r))

			err := d.Deliver(context.Background(), Delivery{
				ChannelKind: KindWebhook,
				Target:      "https://evil.test/hook/abcd1234",
				Payload:     samplePayload(),
			})
			if !errors.Is(err, ErrRefused) {
				t.Fatalf("https://evil.test -> %s: got %v, want an ErrRefused", tc.addr, err)
			}
			// The refusal has to have happened past DNS, not before it: a URL
			// fence would never have asked.
			if len(r.lookedUp) == 0 {
				t.Fatalf("refused without resolving; this fence must be the dial-time one")
			}
		})
	}
}

// A hostname that resolves to a public AND a private address is refused whole.
// Answering "well, we would have dialed the public one" is how rebinding wins:
// the set is the attacker's to order.
func TestDefaultPolicyRefusesMixedResolutionSet(t *testing.T) {
	r := &stubResolver{hosts: map[string][]string{"mixed.test": {"93.184.216.34", "169.254.169.254"}}}
	d := New(strictWith(r))

	err := d.Deliver(context.Background(), Delivery{
		ChannelKind: KindWebhook,
		Target:      "https://mixed.test/hook/abcd1234",
		Payload:     samplePayload(),
	})
	if !errors.Is(err, ErrRefused) {
		t.Fatalf("mixed resolution set: got %v, want an ErrRefused", err)
	}
}

// The connection-bound half of the fence, exercised directly: Control is handed
// the address the kernel is about to connect to, and it is the last word.
func TestControlRefusesTheAddressBeingDialed(t *testing.T) {
	p := Policy{}
	if err := p.control("tcp4", "169.254.169.254:443", nil); !errors.Is(err, ErrRefused) {
		t.Errorf("control(169.254.169.254:443) = %v, want an ErrRefused", err)
	}
	if err := p.control("tcp4", "93.184.216.34:443", nil); err != nil {
		t.Errorf("control(93.184.216.34:443) = %v, want nil", err)
	}
	// A name at this point means something resolved outside the vetted path.
	if err := p.control("tcp4", "evil.test:443", nil); !errors.Is(err, ErrRefused) {
		t.Errorf("control on an unresolved name = %v, want an ErrRefused", err)
	}
	// Under the escape hatch it is deliberately inert (D492).
	if err := (Policy{AllowPrivate: true}).control("tcp4", "127.0.0.1:8080", nil); err != nil {
		t.Errorf("control under AllowPrivate = %v, want nil", err)
	}
}

// (4) The compose/CI policy (D492) — without it the drive cannot prove delivery
// at all, because its receiver is a private-range plain-HTTP hostname.
func TestTestPolicyAdmitsPrivateHTTPTarget(t *testing.T) {
	var gotBody []byte
	var gotType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotType = req.Header.Get("Content-Type")
		gotBody, _ = io.ReadAll(req.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	d := New(Policy{AllowPrivate: true}) // httptest listens on 127.0.0.1, plain http
	if err := d.Deliver(context.Background(), Delivery{
		ChannelKind: KindWebhook,
		Target:      srv.URL + "/hook/abcd1234",
		Payload:     samplePayload(),
	}); err != nil {
		t.Fatalf("delivery under the test policy: %v", err)
	}
	if gotType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", gotType)
	}
	if !strings.Contains(string(gotBody), `"version":1`) {
		t.Errorf("receiver got %q, want the versioned document", gotBody)
	}
}

// PolicyFromEnv: unset is strict, and a typo is an error rather than a silently
// relaxed fence (the config.EnvBool posture — `ture` never means false here).
func TestPolicyFromEnvDefaultsStrict(t *testing.T) {
	t.Setenv(EnvAllowPrivate, "")
	p, err := PolicyFromEnv()
	if err != nil {
		t.Fatalf("PolicyFromEnv with the var unset: %v", err)
	}
	if p.AllowPrivate {
		t.Fatal("PolicyFromEnv defaulted to AllowPrivate; the default must be strict (D492)")
	}

	t.Setenv(EnvAllowPrivate, "true")
	if p, err = PolicyFromEnv(); err != nil || !p.AllowPrivate {
		t.Fatalf("PolicyFromEnv(true) = %+v, %v; want AllowPrivate", p, err)
	}

	t.Setenv(EnvAllowPrivate, "ture")
	if _, err = PolicyFromEnv(); err == nil {
		t.Fatal("PolicyFromEnv(\"ture\") returned no error; a typo must not relax the fence")
	}
}

// The masking rule, stated once here so apps/web's display mirror (T5) has
// something exact to mirror: scheme, host (with port), and the last four
// characters of the path. Query and userinfo never survive.
func TestMaskTarget(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"https://hooks.slack.com/services/T00000000/B00000000/abcdEFGH1234", "https://hooks.slack.com/...1234"},
		{"http://receiver:8080/hook/abcd1234", "http://receiver:8080/...1234"},
		{"https://example.com", "https://example.com/..."},
		{"https://example.com/", "https://example.com/..."},
		{"https://example.com/ab", "https://example.com/...ab"},
		{"https://user:pw@example.com/path/secret1234?token=zzzz", "https://example.com/...1234"},
		{"not a url", "(invalid target)"},
		{"", "(invalid target)"},
		{"://nope", "(invalid target)"},
	} {
		if got := MaskTarget(tc.in); got != tc.want {
			t.Errorf("MaskTarget(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
