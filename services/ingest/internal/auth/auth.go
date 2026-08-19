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

// Resolver maps a bearer token — the exact string the client sent after the
// scheme — to the workspace it writes into. internal/keystore is the
// implementation the service runs; the seam is here so this package stays about
// the header format and knows nothing about where keys are kept or cached.
type Resolver interface {
	Workspace(token string) (string, error)
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

// Workspace resolves the raw value of an Authorization header to the workspace
// it writes into. The token is passed on exactly as sent, minus the scheme and
// surrounding space: ingest does not validate its shape, because the shape is
// the issuer's business and an attacker picks their own (D139).
func (a Authenticator) Workspace(authorization string) (string, error) {
	if len(authorization) <= len(scheme) || !strings.EqualFold(authorization[:len(scheme)], scheme) {
		return "", ErrUnauthorized
	}
	if a.resolver == nil {
		return "", ErrUnauthorized
	}
	// Every resolver failure collapses to the one error here rather than being
	// passed through: the transports answer 401 with whatever this returns, so a
	// resolver that ever described why would describe it to the caller.
	workspaceID, err := a.resolver.Workspace(strings.TrimSpace(authorization[len(scheme):]))
	if err != nil {
		return "", ErrUnauthorized
	}
	return workspaceID, nil
}

type contextKey struct{}

// ContextWithWorkspace carries the authenticated workspace from the transport's
// auth step to the handler that consumes the payload.
func ContextWithWorkspace(ctx context.Context, workspaceID string) context.Context {
	return context.WithValue(ctx, contextKey{}, workspaceID)
}

// WorkspaceFromContext returns the workspace put there by
// ContextWithWorkspace, or "" if the context never passed authentication.
func WorkspaceFromContext(ctx context.Context) string {
	workspaceID, _ := ctx.Value(contextKey{}).(string)
	return workspaceID
}
