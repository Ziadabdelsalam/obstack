package auth_test

import (
	"context"
	"errors"
	"testing"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
)

// A resolver that records what it was handed: the header parsing is this
// package's entire job, so what reaches the store is what has to be asserted.
type fakeResolver struct {
	workspaces map[string]string
	seen       []string
}

func (f *fakeResolver) Workspace(token string) (string, error) {
	f.seen = append(f.seen, token)
	ws, ok := f.workspaces[token]
	if !ok {
		return "", auth.ErrUnauthorized
	}
	return ws, nil
}

func TestWorkspace(t *testing.T) {
	resolver := &fakeResolver{workspaces: map[string]string{
		"ok_dev_local": "ws_demo",
		"ok_live_a1b2": "ws_other",
	}}
	a := auth.New(resolver)

	cases := []struct {
		name          string
		authorization string
		want          string
	}{
		{"dev key", "Bearer ok_dev_local", "ws_demo"},
		{"issued key", "Bearer ok_live_a1b2", "ws_other"},
		{"lowercase scheme", "bearer ok_dev_local", "ws_demo"},
		{"padded key", "Bearer  ok_dev_local ", "ws_demo"},
		{"unknown key", "Bearer ok_dev_nope", ""},
		{"empty header", "", ""},
		{"scheme only", "Bearer ", ""},
		{"wrong scheme", "Basic ok_dev_local", ""},
		{"bare key", "ok_dev_local", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := a.Workspace(tc.authorization)
			if tc.want == "" {
				if !errors.Is(err, auth.ErrUnauthorized) {
					t.Fatalf("Workspace(%q) error = %v, want ErrUnauthorized", tc.authorization, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Workspace(%q) error = %v", tc.authorization, err)
			}
			if got != tc.want {
				t.Fatalf("Workspace(%q) = %q, want %q", tc.authorization, got, tc.want)
			}
		})
	}
}

// A header that is not a bearer header is refused here, before anything asks
// Postgres: an unauthenticated flood must not be a query per request.
func TestOnlyBearerHeadersReachTheResolver(t *testing.T) {
	resolver := &fakeResolver{workspaces: map[string]string{"ok_dev_local": "ws_demo"}}
	a := auth.New(resolver)

	for _, authorization := range []string{"", "Bearer ", "Basic ok_dev_local", "ok_dev_local"} {
		if _, err := a.Workspace(authorization); !errors.Is(err, auth.ErrUnauthorized) {
			t.Errorf("Workspace(%q) error = %v, want ErrUnauthorized", authorization, err)
		}
	}
	if len(resolver.seen) != 0 {
		t.Errorf("resolver was asked about %v; none of those are bearer headers", resolver.seen)
	}

	if _, err := a.Workspace("Bearer  ok_dev_local "); err != nil {
		t.Fatalf("Workspace: %v", err)
	}
	// Exactly the token, with nothing added and nothing kept: the hash the store
	// looks up is over this string.
	if len(resolver.seen) != 1 || resolver.seen[0] != "ok_dev_local" {
		t.Errorf("resolver was handed %q, want the bare token", resolver.seen)
	}
}

// The zero value authorises nothing — a receiver wired without a resolver must
// refuse rather than panic mid-request.
func TestZeroAuthenticatorAuthorisesNothing(t *testing.T) {
	var a auth.Authenticator
	if _, err := a.Workspace("Bearer ok_dev_local"); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("zero Authenticator error = %v, want ErrUnauthorized", err)
	}
}

// A resolver that fails for its own reasons is still one 401 with one message:
// the transports write this error's text into the response.
func TestResolverErrorsAreIndistinguishable(t *testing.T) {
	a := auth.New(resolverFunc(func(string) (string, error) {
		return "", errors.New("dial tcp 127.0.0.1:5432: connect: connection refused")
	}))

	_, err := a.Workspace("Bearer ok_live_a1b2")
	if !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("error = %v, want ErrUnauthorized", err)
	}
	if err.Error() != auth.ErrUnauthorized.Error() {
		t.Errorf("error text = %q; a client must not be told why", err)
	}
}

type resolverFunc func(token string) (string, error)

func (f resolverFunc) Workspace(token string) (string, error) { return f(token) }

func TestWorkspaceContext(t *testing.T) {
	if got := auth.WorkspaceFromContext(context.Background()); got != "" {
		t.Fatalf("unauthenticated context carried workspace %q", got)
	}
	ctx := auth.ContextWithWorkspace(context.Background(), "ws_demo")
	if got := auth.WorkspaceFromContext(ctx); got != "ws_demo" {
		t.Fatalf("WorkspaceFromContext = %q, want ws_demo", got)
	}
}
