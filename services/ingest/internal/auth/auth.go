// Package auth resolves the Phase-1 bearer keys (D4). A client sends
// `Authorization: Bearer ok_dev_…` — settable through the standard
// OTEL_EXPORTER_OTLP_HEADERS — and the key names the workspace every record in
// that request is written into. In M3 only the lookup moves from env to
// Postgres; the wire format resolved here is the one clients keep.
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




// Authenticator maps bearer keys to workspace IDs. The zero value authorises
// nothing.
type Authenticator struct {
	keys map[string]string
}

// New copies the key set so later mutation of the caller's map cannot change
// who is authorised.
func New(keys map[string]string) Authenticator {
	copied := make(map[string]string, len(keys))
	for key, workspaceID := range keys {
		copied[key] = workspaceID
	}
	return Authenticator{keys: copied}
}

// Workspace resolves the raw value of an Authorization header to the workspace
// it writes into.
func (a Authenticator) Workspace(authorization string) (string, error) {
	if len(authorization) <= len(scheme) || !strings.EqualFold(authorization[:len(scheme)], scheme) {
		return "", ErrUnauthorized
	}
	workspaceID, ok := a.keys[strings.TrimSpace(authorization[len(scheme):])]
	if !ok {
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
