package server

import (
	"bytes"
	"testing"

	"github.com/stift-sh/stift/engine/api"
)

// TestTenantIsolation verifies that named tenants get fully separate
// namespaces and that the default ("") tenant is untouched by them — the core
// property a multi-tenant (hosted) build relies on.
func TestTenantIsolation(t *testing.T) {
	dataDir := t.TempDir()
	store, err := OpenStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}

	meta := func(key string) api.Session {
		return api.Session{Key: key, Agent: "claude", SessionID: key, Base: "home"}
	}

	a, _, err := store.Put("orgA", meta("k"), bytes.NewReader([]byte("a")))
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := store.Put("orgB", meta("k"), bytes.NewReader([]byte("b")))
	if err != nil {
		t.Fatal(err)
	}

	// Same key in different tenants are independent records.
	if a.ID == b.ID {
		t.Fatalf("tenants shared an id: %s", a.ID)
	}
	// Each tenant sees only its own session.
	if got := store.List("orgA", ListFilter{}); len(got) != 1 || got[0].ID != a.ID {
		t.Fatalf("orgA list = %+v", got)
	}
	if got := store.List("orgB", ListFilter{}); len(got) != 1 || got[0].ID != b.ID {
		t.Fatalf("orgB list = %+v", got)
	}
	// The default tenant and a never-used tenant are empty.
	if got := store.List("", ListFilter{}); len(got) != 0 {
		t.Fatalf("default tenant leaked sessions: %+v", got)
	}
	// No cross-tenant access by id.
	if _, ok := store.Get("orgB", a.ID); ok {
		t.Fatal("orgB read orgA's session by id")
	}
	if _, err := store.ResolveID("orgB", a.ID); err == nil {
		t.Fatal("orgB resolved orgA's id")
	}

	// Survives reopen with the per-tenant on-disk layout.
	store2, err := OpenStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := store2.Get("orgA", a.ID); !ok || got.Key != "k" {
		t.Fatalf("after reopen orgA: ok=%v got=%+v", ok, got)
	}
	if _, ok := store2.Get("orgB", a.ID); ok {
		t.Fatal("after reopen, cross-tenant id leaked")
	}

	// Tenant names are validated against path traversal.
	if _, _, err := store.Put("../escape", meta("x"), bytes.NewReader([]byte("x"))); err == nil {
		t.Fatal("invalid tenant accepted")
	}
}
