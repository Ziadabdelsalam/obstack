package notify

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strings"
	"syscall"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/config"
)

// EnvAllowPrivate is D492's escape hatch: the ONE variable that relaxes the
// egress fences, for compose and CI only. The drive's webhook receiver is a
// compose-internal hostname on a private address speaking plain HTTP, so without
// this the drive cannot prove delivery at all — and a fence nothing exercises is
// a fence nobody notices breaking.
//
// Production never sets it. That is not a convention: the deploy touchpoint
// verifies its absence, because the failure mode of a stray `true` in a
// production environment is a webhook target pointed at the cloud metadata
// endpoint and an SSRF with a UI in front of it.
const EnvAllowPrivate = "OBSTACK_NOTIFIER_ALLOW_PRIVATE"

// ErrRefused is what every egress-policy refusal wraps. Callers distinguish
// "this target is not one we will ever dial" from "the far end was down" with
// errors.Is: the first is a permanent verdict on the channel, the second is
// worth another attempt.
var ErrRefused = errors.New("notify: refused by egress policy")

// Policy is the set of addresses this process is willing to open a connection
// to. Its zero value is the STRICT policy (D492) — a Policy nobody configured is
// a Policy that refuses everything interesting, which is the right way round for
// a fence.
type Policy struct {
	// AllowPrivate relaxes the scheme and address checks together: plain HTTP
	// becomes acceptable and no address range is refused. Compose and CI only;
	// see EnvAllowPrivate.
	AllowPrivate bool

	// resolve maps a hostname to its addresses. Unexported and unset outside
	// tests, where it is the whole reason the dial-time fence can be proven
	// without a DNS server, an /etc/hosts edit, or a domain someone has to keep
	// pointed at a private address for the suite to stay honest. Nothing outside
	// this package can substitute a resolver, which is deliberate: an injectable
	// resolver on the public surface would be a way to walk around the fence.
	resolve func(ctx context.Context, host string) ([]netip.Addr, error)
}

// PolicyFromEnv builds the policy from the environment. Unset means strict.
//
// A malformed value is an error rather than a fallback, the config.EnvBool
// posture: `ture` must not quietly mean "strict" any more than it may quietly
// mean "relaxed" — an operator who typo'd the variable needs to hear about it
// at boot, not from a delivery that silently did or did not happen.
func PolicyFromEnv() (Policy, error) {
	allow, err := config.EnvBool(EnvAllowPrivate, false)
	if err != nil {
		return Policy{}, err
	}
	return Policy{AllowPrivate: allow}, nil
}

// checkTarget is the URL-shaped half of the fence, applied before anything is
// dialed. It can only see what the operator typed, which is why it is the half
// that does NOT decide whether the target is safe — see dialContext.
func (p Policy) checkTarget(target string) error {
	u, err := url.Parse(target)
	if err != nil {
		return fmt.Errorf("%w: %s is not a URL", ErrRefused, MaskTarget(target))
	}
	switch {
	case u.Host == "":
		return fmt.Errorf("%w: %s has no host", ErrRefused, MaskTarget(target))
	case p.AllowPrivate && u.Scheme != "https" && u.Scheme != "http":
		// The hatch relaxes http, and nothing else. file: and gopher: are not
		// "private", they are a different attack.
		return fmt.Errorf("%w: scheme %q is not http or https", ErrRefused, u.Scheme)
	case !p.AllowPrivate && u.Scheme != "https":
		// A channel target is a credential and the payload names a customer's
		// incident. Plaintext is not something an operator gets to opt into by
		// typing a URL into a form.
		return fmt.Errorf("%w: scheme %q is not https", ErrRefused, u.Scheme)
	}
	if p.AllowPrivate {
		return nil
	}
	// A literal IP is refused whether or not it is public. The address fence
	// below works on what a NAME resolves to; a literal address is the obvious
	// way around it, so requiring a name is what makes the fence load-bearing.
	if _, err := netip.ParseAddr(u.Hostname()); err == nil {
		return fmt.Errorf("%w: %s addresses a host by literal IP", ErrRefused, MaskTarget(target))
	}
	return nil
}

// dialContext is the fence that matters: it runs after DNS, and the connection
// it returns is bound to an address it vetted itself.
//
// The sequence is resolve → vet every address → dial a vetted IP LITERAL, with
// Control re-checking the exact address the kernel is about to connect to. There
// is deliberately no step that hands a NAME to the network stack after a check,
// because that step is the DNS-rebinding hole: a name checked at T and dialed at
// T+ε can resolve to two different addresses, and the attacker picks both.
//
// Vetting is over the WHOLE resolved set, not just the address we would have
// dialed first. A name answering with one public and one private address is
// refused outright — "we would have used the public one" concedes the ordering
// of that set to whoever controls the zone.
func (p Policy) dialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	dialer := &net.Dialer{Control: p.control}
	if p.AllowPrivate {
		// D492: compose reaches its receiver by name on a private address.
		// Control still runs and is inert under this policy.
		return dialer.DialContext(ctx, network, addr)
	}

	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("%w: malformed dial address", ErrRefused)
	}
	addrs, err := p.lookup(ctx, host)
	if err != nil {
		return nil, err
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("%w: %s resolved to no addresses", ErrRefused, host)
	}
	for _, ip := range addrs {
		if err := checkAddr(ip); err != nil {
			return nil, err
		}
	}

	var firstErr error
	for _, ip := range addrs {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, firstErr
}

// control is the last word before connect(2). It is handed the address the
// socket is about to be pointed at, so whatever resolved it and whenever, this
// hook sees the truth.
//
// It duplicates the check dialContext already did, on purpose: the duplication
// is what makes the guarantee structural rather than a property of the order of
// statements above it. Any future path into this dialer — a redirect, a retry,
// an HTTP/2 coalesced connection, a refactor — passes through here.
func (p Policy) control(_, address string, _ syscall.RawConn) error {
	if p.AllowPrivate {
		return nil
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("%w: malformed dial address", ErrRefused)
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		// Control receives resolved addresses. A name here means something
		// resolved outside the vetted path, which is precisely the case this
		// hook exists to refuse.
		return fmt.Errorf("%w: dial address %q was never vetted", ErrRefused, host)
	}
	return checkAddr(ip)
}

// lookup resolves a name, through the injected resolver in tests and the system
// resolver everywhere else.
func (p Policy) lookup(ctx context.Context, host string) ([]netip.Addr, error) {
	if p.resolve != nil {
		return p.resolve(ctx, host)
	}
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

// checkAddr is D487's refused-address list, and exactly that list: loopback,
// RFC 1918 private, link-local (which is where 169.254.169.254 lives — the
// cloud metadata endpoint is the prize in every SSRF write-up), IPv6
// unique-local, unspecified, and multicast. Widening it — carrier-grade NAT,
// benchmarking ranges — is a deliberate call for a later run, not something to
// slip in beside a bug fix, because each addition is a webhook target somebody
// might legitimately have.
func checkAddr(ip netip.Addr) error {
	// ::ffff:169.254.169.254 is 169.254.169.254 wearing a hat.
	a := ip.Unmap()
	switch {
	case !a.IsValid():
		return fmt.Errorf("%w: invalid address", ErrRefused)
	case a.IsUnspecified():
		return refuseAddr(a, "unspecified")
	case a.IsLoopback():
		return refuseAddr(a, "loopback")
	case a.IsLinkLocalUnicast(), a.IsLinkLocalMulticast():
		return refuseAddr(a, "link-local")
	case a.IsInterfaceLocalMulticast(), a.IsMulticast():
		return refuseAddr(a, "multicast")
	case a.IsPrivate():
		// netip.Addr.IsPrivate covers RFC 1918 and IPv6 unique-local (fc00::/7).
		return refuseAddr(a, "private")
	}
	return nil
}

// refuseAddr names the address it refused. The resolved IP is not a secret — the
// hostname it came from is already in every masked target — and an operator
// reading "refused 169.254.169.254" learns in one line what "refused" alone
// would have cost them an afternoon.
func refuseAddr(a netip.Addr, class string) error {
	return fmt.Errorf("%w: %s is a %s address", ErrRefused, a.String(), class)
}

// MaskTarget renders a channel target for anywhere a human might read it: an
// error, an ops log, the product's channel list.
//
// The rule, stated once and exactly, because apps/web re-implements it for
// display (apps/web/src/server/queries/alerts.ts, T5) and the drive's hygiene
// sweep cross-checks that nothing anywhere emits the unmasked form:
//
//	scheme + "://" + host (with port) + "/..." + the last 4 characters of the path
//
// Query string and userinfo are dropped entirely — both routinely carry the
// token. A target that does not parse as an absolute URL renders as
// "(invalid target)" rather than being echoed, since something unparseable is
// exactly when a caller is most tempted to print the raw string "just to see".
func MaskTarget(target string) string {
	u, err := url.Parse(target)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "(invalid target)"
	}
	tail := []rune(strings.TrimPrefix(u.EscapedPath(), "/"))
	if len(tail) > 4 {
		tail = tail[len(tail)-4:]
	}
	return u.Scheme + "://" + u.Host + "/..." + string(tail)
}
