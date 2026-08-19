// Package auth reads the bearer keys clients authenticate with (D4). A client
// sends `Authorization: Bearer ok_…` — settable through the standard
// OTEL_EXPORTER_OTLP_HEADERS — and the key names the workspace every record in
// that request is written into. The wire format is the one M1 shipped and is
// unchanged; only the lookup moved, from an env map to Postgres
// (internal/keystore).
package auth

import (
	"context"
	"errors"
	"strings"
)

// ErrUnauthorized covers a missing, malformed, or unknown key alike. The cases
// are deliberately indistinguishable to the caller: separate answers would turn
// the endpoint into a key-probing oracle.
var ErrUnauthorized = errors.New("missing or unknown API key")

const scheme = "bearer "

// Identity is who a request turned out to be: the workspace every record in it
// is written into, and the key that carried it. The key half exists because the
// per-key health rows (D100) are the product's liveness surface and the receive
// path has nothing else to attribute an accepted record to. Both halves are
// server-internal — nothing about the wire contract changed when the seam
// widened, and neither value is ever echoed to a client (D6).
type Identity struct {
	WorkspaceID string
	KeyID       string
}

// Resolver maps a bearer token — the exact string the client sent after the
// scheme — to the identity it writes as. internal/keystore is the
// implementation the service runs; the seam is here so this package stays about
// the header format and knows nothing about where keys are kept or cached.
type Resolver interface {
	Workspace(token string) (Identity, error)
}

// Authenticator turns an Authorization header into a workspace. The zero value
// authorises nothing.
type Authenticator struct {
	resolver Resolver
}

// New wires the Authenticator to the resolver that answers for it.
func New(resolver Resolver) Authenticator {
	return Authenticator{resolver: resolver}
}

// Workspace resolves the raw value of an Authorization header to the identity
// it writes as. The token is passed on exactly as sent, minus the scheme and
// surrounding space: ingest does not validate its shape, because the shape is
// the issuer's business and an attacker picks their own (D139).
func (a Authenticator) Workspace(authorization string) (Identity, error) {
	if len(authorization) <= len(scheme) || !strings.EqualFold(authorization[:len(scheme)], scheme) {
		return Identity{}, ErrUnauthorized
	}
	if a.resolver == nil {
		return Identity{}, ErrUnauthorized
	}
	// Every resolver failure collapses to the one error here rather than being
	// passed through: the transports answer 401 with whatever this returns, so a
	// resolver that ever described why would describe it to the caller.
	identity, err := a.resolver.Workspace(strings.TrimSpace(authorization[len(scheme):]))
	if err != nil {
		return Identity{}, ErrUnauthorized
	}
	return identity, nil
}

type contextKey struct{}

// ContextWithIdentity carries the authenticated identity from the transport's
// auth step to the handler that consumes the payload.
func ContextWithIdentity(ctx context.Context, identity Identity) context.Context {
	return context.WithValue(ctx, contextKey{}, identity)
}

// IdentityFromContext returns the identity put there by ContextWithIdentity, or
// the zero Identity if the context never passed authentication.
func IdentityFromContext(ctx context.Context) Identity {
	identity, _ := ctx.Value(contextKey{}).(Identity)
	return identity
}
