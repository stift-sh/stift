package server_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/stift-sh/stift/engine/api"
	"github.com/stift-sh/stift/engine/server"
	"github.com/stift-sh/stift/engine/server/backendtest"
)

// TestDiskStoreContract runs the shared Backend contract suite against
// DiskStore.
func TestDiskStoreContract(t *testing.T) {
	backendtest.Run(t, func(t *testing.T) server.Backend {
		store, err := server.OpenStore(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		return store
	})
}

// TestBundlesSurviveReopen verifies HEADs are reloaded from disk for both the
// default and named tenants.
func TestBundlesSurviveReopen(t *testing.T) {
	dataDir := t.TempDir()
	store, err := server.OpenStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("---\nname: s\n---\n")
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])
	userKey := server.BundleKey{Scope: "user", Agent: "claude", Name: "skills/s"}
	for _, tenant := range []string{"", "orgA"} {
		if err := store.PutBlob(tenant, sha, bytes.NewReader(data), int64(len(data))); err != nil {
			t.Fatal(err)
		}
		f := api.BundleFile{Path: "SKILL.md", SHA256: sha, Size: int64(len(data))}
		for i := 0; i < 2; i++ {
			if _, err := store.PutBundle(tenant, userKey, api.Bundle{Parent: i, Files: []api.BundleFile{f}}, false); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := store.PutBundle("orgA", server.BundleKey{Scope: "project", Agent: "claude", Project: "/x", Name: ".claude/CLAUDE.md"}, api.Bundle{}, false); err != nil {
		t.Fatal(err)
	}

	store2, err := server.OpenStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, tenant := range []string{"", "orgA"} {
		b, ok := store2.GetBundle(tenant, userKey, 0)
		if !ok || b.Version != 2 || b.Name != "skills/s" || len(b.Skills) != 1 || b.Skills[0].Name != "s" {
			t.Fatalf("tenant %q after reopen: ok=%v %+v", tenant, ok, b)
		}
		// Next write must continue from the reloaded HEAD.
		if _, err := store2.PutBundle(tenant, userKey, api.Bundle{Parent: 1}, false); !errors.Is(err, server.ErrStale) {
			t.Fatalf("tenant %q: expected ErrStale after reopen, got %v", tenant, err)
		}
		if h := store2.BundleHistory(tenant, userKey); len(h) != 2 {
			t.Fatalf("tenant %q history after reopen = %+v", tenant, h)
		}
	}
	if got := store2.ListBundles("orgA", server.BundleFilter{}); len(got) != 2 {
		t.Fatalf("orgA list after reopen = %+v", got)
	}
	if got := store2.ListBundles("", server.BundleFilter{}); len(got) != 1 {
		t.Fatalf("default list after reopen = %+v", got)
	}
	if _, err := store2.OpenBlob("orgA", sha); err != nil {
		t.Fatal(err)
	}
}
