package auth_test

import (
	"context"
	"errors"
	"testing"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
)

func TestWorkspace(t *testing.T) {
	a := auth.New(map[string]string{
		"ok_dev_local": "ws_demo",
		"ok_dev_other": "ws_other",
	})

	cases := []struct {
		name          string
		authorization string
		want          string
	}{
		{"known key", "Bearer ok_dev_local", "ws_demo"},
		{"second key", "Bearer ok_dev_other", "ws_other"},
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

func TestNewCopiesKeys(t *testing.T) {
	keys := map[string]string{"ok_dev_local": "ws_demo"}
	a := auth.New(keys)
	delete(keys, "ok_dev_local")

	if got, err := a.Workspace("Bearer ok_dev_local"); err != nil || got != "ws_demo" {
		t.Fatalf("Workspace after caller mutated its map = %q, %v", got, err)
	}
}

func TestWorkspaceContext(t *testing.T) {
	if got := auth.WorkspaceFromContext(context.Background()); got != "" {
		t.Fatalf("unauthenticated context carried workspace %q", got)
	}
	ctx := auth.ContextWithWorkspace(context.Background(), "ws_demo")
	if got := auth.WorkspaceFromContext(ctx); got != "ws_demo" {
		t.Fatalf("WorkspaceFromContext = %q, want ws_demo", got)
	}
}
