// Package notify delivers one alert event to one notification channel, and
// nothing else.
//
// It is the egress edge of the alerting engine (packet §3, D486/D487/D492): the
// only place in this process that opens a connection to a URL a customer typed
// into a form. That is what makes it security-bearing, and the fences below are
// the package's actual subject — the HTTP POST is the easy part.
//
// Three fences, all of them code:
//
//   - Scheme and address. The default policy — env unset — speaks https only,
//     refuses a host given as a literal IP, and refuses any address that
//     resolves into loopback, RFC 1918, link-local (169.254.169.254 included),
//     unique-local, unspecified or multicast space. Crucially the check is bound
//     to the CONNECTION: the dialer resolves the name itself, vets every address
//     it got back, then dials a vetted IP literal with a Control hook that
//     re-checks the exact address the kernel is about to connect to. There is no
//     window between "checked" and "dialed" for DNS to change its answer in, and
//     no path into the socket that skips the check. See policy.go.
//
//   - Secrets. A channel target IS a credential — a Slack webhook URL is its own
//     password — so it must not survive into an error, a log line or a panic,
//     because an error gets logged and a log goes somewhere neither we nor the
//     customer chose. Every error that names a target names MaskTarget's
//     rendering instead, and transport errors are UNWRAPPED before being wrapped
//     again: net/http's *url.Error carries the full URL in its own message, and
//     that — not any log statement of ours — is how this leaks in practice. This
//     package logs nothing at all, which is the cheapest way to keep that true.
//
//   - Rate. Deliveries are capped per workspace at a fixed constant per minute,
//     so a workspace whose rules are all firing cannot turn this process into a
//     traffic generator pointed at somebody else's endpoint. A breach is a typed
//     error and an ops counter, never a silent drop.
//
// One call is one attempt. There is no retry, no backoff and no queue here:
// D490 puts attempts, the `attempts` column and the delivered/failed verdict in
// the deliverer loop that CALLS this package, so that a crash mid-retry is still
// resolved by the event row rather than by this process's memory. A Deliverer
// that retried internally would make that column lie about how many times a
// customer's endpoint was actually hit.
package notify

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

const (
	// DeliveriesPerWorkspacePerMinute is the per-workspace cap (D487). It is a
	// constant and not a plan dimension: it exists to bound what this process
	// can do to a third party, which is not a thing a customer buys more of.
	// Sixty a minute is far above the honest ceiling — D479's 60s cadence means
	// a workspace would need sixty rules all transitioning every single tick to
	// reach it — so tripping this is a bug or an abuse, never a busy Tuesday.
	DeliveriesPerWorkspacePerMinute = 60

	// rateWindow is the fixed window the cap counts in. Fixed rather than
	// sliding because the cap is a blast-radius bound, not a smoothness
	// guarantee, and a fixed window is one comparison and one integer.
	rateWindow = time.Minute

	// maxTrackedWorkspaces bounds the rate-limiter's map. Past it, entries whose
	// window has expired are dropped — the metering maxLedgerBuckets posture:
	// a per-workspace map keyed by data that arrives over time gets a stated
	// bound rather than an assumption that the key space is small.
	maxTrackedWorkspaces = 4096

	// maxResponseBytes is how much of a response we read before discarding it.
	// Nothing here reads the body — a webhook receiver's opinion is its status
	// code — but draining a little of it lets the connection close cleanly, and
	// the cap is what stops a receiver answering 200 with a gigabyte.
	maxResponseBytes = 4 << 10
)

// Delivery outcomes. Every Deliver call lands in exactly one, so "did alerts go
// out" is a counter an operator reads rather than an inference they make.
const (
	outcomeDelivered   = "delivered"
	outcomeFailed      = "failed"
	outcomeRefused     = "refused"
	outcomeRateLimited = "rate_limited"
)

// ErrRateLimited is the typed breach of the per-workspace cap. The caller's loop
// distinguishes it from a transport failure: a rate-limited delivery was never
// attempted, so it is worth retrying and must not burn an attempt.
var ErrRateLimited = errors.New("notify: workspace delivery rate cap exceeded")

// Ops-only counters, the metering/retention split: these are for the operator
// watching the notifier itself. What a customer sees is the `delivery` column on
// their event row, which is written by the caller and is the truth the product
// renders — these are never reconciled against it.
var (
	deliveries = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "obstack_ingest_notify_deliveries_total",
		Help: "Notification delivery attempts by outcome: delivered, failed, refused by egress policy, or rate_limited.",
	}, []string{"outcome"})

	// rateLimited is D487's named ops-counter on cap breach. It overlaps
	// deliveries{outcome="rate_limited"} on purpose: a breach is the one outcome
	// that means somebody should look, and it should not require knowing the
	// label vocabulary to alert on.
	rateLimited = promauto.NewCounter(prometheus.CounterOpts{
		Name: "obstack_ingest_notify_rate_limited_total",
		Help: "Deliveries refused by the per-workspace rate cap without being attempted.",
	})
)

// StatusError is a non-2xx answer from the far end. Typed so the caller's loop
// can tell a receiver that said no from one that could not be reached; its
// message deliberately carries no URL, since it is wrapped by an error that
// already names the masked target.
type StatusError struct {
	StatusCode int
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("non-2xx response status %d", e.StatusCode)
}

// Delivery is one event going to one channel.
type Delivery struct {
	// ChannelKind is KindWebhook or KindSlackWebhook; it selects the body.
	ChannelKind string
	// Target is the channel's URL. It is a CREDENTIAL: pass it here, never into
	// a log line or an error, and render it for humans with MaskTarget.
	Target string
	// Payload is the alert. Its Workspace field is what the rate cap counts.
	Payload Payload
}

// Deliverer performs deliveries under one Policy.
//
// It is a struct rather than an interface because it returns a concrete thing;
// the caller that wants to substitute a fake in its own tests should declare the
// one-method interface it needs on its own side (accept interfaces, return
// structs). Safe for concurrent use.
type Deliverer struct {
	policy Policy
	client *http.Client

	// now is the clock, a field for the same reason metering's is: a rate
	// window is not something a test can wait out.
	now func() time.Time

	mu      sync.Mutex
	windows map[string]rateWindowState
}

// rateWindowState is one workspace's current fixed window.
type rateWindowState struct {
	start time.Time
	count int
}

// New builds a Deliverer whose every connection goes through p.
func New(p Policy) *Deliverer {
	return &Deliverer{
		policy:  p,
		now:     time.Now,
		windows: make(map[string]rateWindowState),
		client: &http.Client{
			Transport: &http.Transport{
				// No proxy, explicitly and not by omission. Honouring
				// HTTP_PROXY here would hand the whole address fence to
				// whoever set that variable: the dial would go to the proxy —
				// which passes every check — and the proxy would happily fetch
				// the metadata endpoint on our behalf.
				Proxy: nil,

				DialContext: p.dialContext,

				// One POST per delivery and at most sixty a minute per
				// workspace, so a connection pool buys nothing; dropping it
				// means every delivery re-runs the full resolve-and-vet
				// sequence rather than inheriting a socket vetted minutes ago.
				DisableKeepAlives: true,

				// The body cap has a sibling: a receiver that answers with
				// unbounded HEADERS would otherwise be read into memory before
				// any status code exists to check.
				MaxResponseHeaderBytes: 16 << 10,
			},

			// Deliberately no Client.Timeout: the caller bounds the attempt
			// with the context it passes, and a second timeout here would
			// silently override it in one direction or the other.

			// Redirects are never followed. A 3xx is a remote server choosing
			// our next destination, which is exactly the decision the address
			// fence exists to deny it — and following one would evaluate the
			// scheme check against a URL the operator never configured. The
			// 3xx is simply not a 2xx.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// Deliver POSTs one event to one channel and reports what happened. One call is
// one attempt (D490) — see the package comment.
//
// The context bounds the attempt; callers are expected to pass a deadline. No
// error returned from here contains the target: they name MaskTarget(target)
// instead, including the errors net/http hands us with the URL baked into their
// own text.
func (d *Deliverer) Deliver(ctx context.Context, dl Delivery) error {
	body, err := encodeBody(dl.ChannelKind, dl.Payload)
	if err != nil {
		deliveries.WithLabelValues(outcomeRefused).Inc()
		return err
	}

	// The policy first, and before the rate cap: a refused target performs no
	// egress, so it should not consume a workspace's budget for the targets
	// that would have.
	if err := d.policy.checkTarget(dl.Target); err != nil {
		deliveries.WithLabelValues(outcomeRefused).Inc()
		return err
	}

	if !d.allow(dl.Payload.Workspace) {
		rateLimited.Inc()
		deliveries.WithLabelValues(outcomeRateLimited).Inc()
		return fmt.Errorf("%w: %d in the last minute", ErrRateLimited, DeliveriesPerWorkspacePerMinute)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, dl.Target, bytes.NewReader(body))
	if err != nil {
		deliveries.WithLabelValues(outcomeFailed).Inc()
		return fmt.Errorf("notify: POST %s: %w", MaskTarget(dl.Target), stripURL(err))
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "obstack-notifier/1")

	resp, err := d.client.Do(req)
	if err != nil {
		deliveries.WithLabelValues(outcomeFailed).Inc()
		return fmt.Errorf("notify: POST %s: %w", MaskTarget(dl.Target), stripURL(err))
	}
	defer resp.Body.Close()

	// Read a little and throw it away. The status code is the whole answer.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxResponseBytes))

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		deliveries.WithLabelValues(outcomeFailed).Inc()
		return fmt.Errorf("notify: POST %s: %w", MaskTarget(dl.Target), &StatusError{StatusCode: resp.StatusCode})
	}
	deliveries.WithLabelValues(outcomeDelivered).Inc()
	return nil
}

// allow takes one token from the workspace's fixed window, reporting whether
// there was one.
func (d *Deliverer) allow(workspace string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()

	now := d.now()
	w := d.windows[workspace]
	// A zero window start is older than any window, so a first-seen workspace
	// starts a fresh one here without a special case.
	if now.Sub(w.start) >= rateWindow {
		w = rateWindowState{start: now}
	}
	if w.count >= DeliveriesPerWorkspacePerMinute {
		d.windows[workspace] = w
		return false
	}
	w.count++
	d.windows[workspace] = w

	if len(d.windows) > maxTrackedWorkspaces {
		d.pruneLocked(now)
	}
	return true
}

// pruneLocked drops workspaces whose window has expired. Called only when the
// map is over its stated bound, so the common path stays one map lookup.
func (d *Deliverer) pruneLocked(now time.Time) {
	for ws, w := range d.windows {
		if now.Sub(w.start) >= rateWindow {
			delete(d.windows, ws)
		}
	}
}

// stripURL removes net/http's *url.Error wrapper, which prints the full request
// URL — the credential — in its own message. Only the wrapper goes: everything
// underneath is preserved and still wrapped with %w, so errors.Is against
// context.DeadlineExceeded, ErrRefused and the rest keeps working for the
// caller's loop.
func stripURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}
