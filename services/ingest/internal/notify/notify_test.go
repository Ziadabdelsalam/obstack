package notify

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// The secret in every leak test below. A Slack webhook URL IS its password, so
// the whole target — and this segment above all — must not survive into an
// error, which is where secrets usually escape: an error gets logged, and a log
// line goes somewhere neither we nor the customer chose.
const secretPath = "/hook/s3cret-Kx91ZzQ7"

// (6) The delivery error names a masked target and nothing else. Two paths,
// because they fail differently: a transport failure (net/http builds a
// *url.Error carrying the full URL in its message — the leak that actually
// happens) and a non-2xx response.
func TestDeliveryErrorNeverContainsTheTarget(t *testing.T) {
	t.Run("transport failure", func(t *testing.T) {
		// Port 1 on loopback: nothing listens, so this is a dial error.
		target := "http://127.0.0.1:1" + secretPath
		d := New(Policy{AllowPrivate: true})

		err := d.Deliver(context.Background(), Delivery{
			ChannelKind: KindWebhook, Target: target, Payload: samplePayload(),
		})
		if err == nil {
			t.Fatal("delivery to a dead port succeeded")
		}
		assertNoTargetLeak(t, err, target)
	})

	t.Run("non-2xx response", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "nope", http.StatusInternalServerError)
		}))
		defer srv.Close()
		target := srv.URL + secretPath
		d := New(Policy{AllowPrivate: true})

		err := d.Deliver(context.Background(), Delivery{
			ChannelKind: KindWebhook, Target: target, Payload: samplePayload(),
		})
		if err == nil {
			t.Fatal("delivery got a 500 and reported success")
		}
		var se *StatusError
		if !errors.As(err, &se) || se.StatusCode != http.StatusInternalServerError {
			t.Errorf("got %v, want a *StatusError with 500", err)
		}
		assertNoTargetLeak(t, err, target)
	})

	t.Run("policy refusal", func(t *testing.T) {
		r := &stubResolver{hosts: map[string][]string{"evil.test": {"169.254.169.254"}}}
		target := "https://evil.test" + secretPath
		err := New(strictWith(r)).Deliver(context.Background(), Delivery{
			ChannelKind: KindWebhook, Target: target, Payload: samplePayload(),
		})
		if err == nil {
			t.Fatal("refusal returned no error")
		}
		assertNoTargetLeak(t, err, target)
	})

	t.Run("timeout", func(t *testing.T) {
		block := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			<-block
		}))
		defer func() { close(block); srv.Close() }()
		target := srv.URL + secretPath

		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		err := New(Policy{AllowPrivate: true}).Deliver(ctx, Delivery{
			ChannelKind: KindWebhook, Target: target, Payload: samplePayload(),
		})
		if err == nil {
			t.Fatal("a delivery past its deadline reported success")
		}
		// The caller bounds the attempt; the deadline has to survive the
		// unwrapping that strips the URL, or T4 cannot tell a timeout from a
		// refusal.
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("got %v, want a context.DeadlineExceeded", err)
		}
		assertNoTargetLeak(t, err, target)
	})
}

func assertNoTargetLeak(t *testing.T, err error, target string) {
	t.Helper()
	msg := err.Error()
	if strings.Contains(msg, target) {
		t.Errorf("error text contains the whole target:\n  %s", msg)
	}
	if strings.Contains(msg, "s3cret-Kx91ZzQ7") {
		t.Errorf("error text contains the credential:\n  %s", msg)
	}
	if !strings.Contains(msg, MaskTarget(target)) {
		t.Errorf("error text %q does not name the masked target %q", msg, MaskTarget(target))
	}
}

// (7) The per-workspace cap, at the constant. Fixed window, so the clock is
// injected — a rate test that waits a minute is a rate test nobody runs.
func TestRateCapTripsAtTheConstant(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 2, 14, 0, 0, 0, time.UTC)
	d := New(Policy{AllowPrivate: true})
	d.now = func() time.Time { return now }

	send := func(ws string) error {
		p := samplePayload()
		p.Workspace = ws
		return d.Deliver(context.Background(), Delivery{
			ChannelKind: KindWebhook, Target: srv.URL + "/hook/abcd1234", Payload: p,
		})
	}

	before := testutil.ToFloat64(rateLimited)
	for i := 0; i < DeliveriesPerWorkspacePerMinute; i++ {
		if err := send("ws_loud"); err != nil {
			t.Fatalf("delivery %d of %d: %v", i+1, DeliveriesPerWorkspacePerMinute, err)
		}
	}
	if hits != DeliveriesPerWorkspacePerMinute {
		t.Fatalf("receiver saw %d requests, want %d", hits, DeliveriesPerWorkspacePerMinute)
	}

	err := send("ws_loud")
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("delivery %d: got %v, want an ErrRateLimited", DeliveriesPerWorkspacePerMinute+1, err)
	}
	if hits != DeliveriesPerWorkspacePerMinute {
		t.Errorf("the capped delivery still hit the network (%d requests)", hits)
	}
	if got := testutil.ToFloat64(rateLimited) - before; got != 1 {
		t.Errorf("rate-limit counter moved by %v, want 1", got)
	}

	// The cap is per workspace: one loud tenant does not silence another's pager.
	if err := send("ws_quiet"); err != nil {
		t.Errorf("second workspace was capped by the first: %v", err)
	}

	// And it is a window, not a ceiling.
	now = now.Add(time.Minute)
	if err := send("ws_loud"); err != nil {
		t.Errorf("next window: %v", err)
	}
}

// One call is one attempt (D490). Retry, backoff and the delivered/failed
// verdict belong to T4's deliverer loop, where a crash mid-retry is still
// resolved by the event row rather than by this process's memory.
func TestDeliverMakesExactlyOneAttempt(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		http.Error(w, "try again", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	err := New(Policy{AllowPrivate: true}).Deliver(context.Background(), Delivery{
		ChannelKind: KindWebhook, Target: srv.URL + "/hook/abcd1234", Payload: samplePayload(),
	})
	if err == nil {
		t.Fatal("a 503 reported success")
	}
	if hits != 1 {
		t.Errorf("receiver saw %d requests, want exactly 1 — this package does not retry", hits)
	}
}

// A redirect is a remote server choosing our next destination, which is exactly
// what the address fence exists to deny it. We do not follow one; the 3xx is
// simply not a 2xx.
func TestRedirectsAreNotFollowed(t *testing.T) {
	var elsewhere int
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		elsewhere++
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		http.Redirect(w, req, target.URL+"/hook/abcd1234", http.StatusFound)
	}))
	defer srv.Close()

	err := New(Policy{AllowPrivate: true}).Deliver(context.Background(), Delivery{
		ChannelKind: KindWebhook, Target: srv.URL + "/hook/abcd1234", Payload: samplePayload(),
	})
	var se *StatusError
	if !errors.As(err, &se) || se.StatusCode != http.StatusFound {
		t.Fatalf("got %v, want a *StatusError with 302", err)
	}
	if elsewhere != 0 {
		t.Errorf("the redirect was followed (%d hits on the second server)", elsewhere)
	}
}

// The response body is read to a small cap and discarded. A webhook receiver
// that answers 200 with a gigabyte is not something this process pages on.
func TestResponseBodyIsCappedAndDiscarded(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		big := strings.Repeat("x", 512*1024)
		_, _ = io.WriteString(w, big)
	}))
	defer srv.Close()

	if err := New(Policy{AllowPrivate: true}).Deliver(context.Background(), Delivery{
		ChannelKind: KindWebhook, Target: srv.URL + "/hook/abcd1234", Payload: samplePayload(),
	}); err != nil {
		t.Fatalf("delivery with an oversized response body: %v", err)
	}
	if maxResponseBytes > 64<<10 {
		t.Errorf("maxResponseBytes = %d; the cap is meant to be small", maxResponseBytes)
	}
}

// Every Deliver lands in exactly one outcome bucket, so the ops view of "did
// alerts go out" is a single counter rather than an inference.
func TestOutcomeCounterMoves(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	d := New(Policy{AllowPrivate: true})
	before := testutil.ToFloat64(deliveries.WithLabelValues(outcomeDelivered))
	if err := d.Deliver(context.Background(), Delivery{
		ChannelKind: KindWebhook, Target: srv.URL + "/hook/abcd1234", Payload: samplePayload(),
	}); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if got := testutil.ToFloat64(deliveries.WithLabelValues(outcomeDelivered)) - before; got != 1 {
		t.Errorf("delivered counter moved by %v, want 1", got)
	}

	beforeRefused := testutil.ToFloat64(deliveries.WithLabelValues(outcomeRefused))
	_ = New(Policy{}).Deliver(context.Background(), Delivery{
		ChannelKind: KindWebhook, Target: "http://example.com/hook/abcd1234", Payload: samplePayload(),
	})
	if got := testutil.ToFloat64(deliveries.WithLabelValues(outcomeRefused)) - beforeRefused; got != 1 {
		t.Errorf("refused counter moved by %v, want 1", got)
	}
}
