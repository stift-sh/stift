// Package backendtest is the contract suite every server.Backend
// implementation must pass. The OSS DiskStore runs it in this repo; other
// implementations (e.g. object-store backed) run it in theirs so that
// behaviour stays identical across deployments.
package backendtest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/stift-sh/stift/engine/api"
	"github.com/stift-sh/stift/engine/server"
)

func sha(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// putBlob stores content and returns its manifest entry.
func putBlob(t *testing.T, b server.Backend, tenant, p string, content string) api.BundleFile {
	t.Helper()
	data := []byte(content)
	if err := b.PutBlob(tenant, sha(data), bytes.NewReader(data), int64(len(data))); err != nil {
		t.Fatalf("PutBlob(%s): %v", p, err)
	}
	return api.BundleFile{Path: p, SHA256: sha(data), Size: int64(len(data)), Mode: 0o644}
}

// Run exercises the blob and bundle contract against a fresh backend per
// subtest.
func Run(t *testing.T, open func(t *testing.T) server.Backend) {
	t.Run("Blobs", func(t *testing.T) { testBlobs(t, open(t)) })
	t.Run("BundleVersioning", func(t *testing.T) { testVersioning(t, open(t)) })
	t.Run("BundleHistory", func(t *testing.T) { testHistory(t, open(t)) })
	t.Run("TenantIsolation", func(t *testing.T) { testTenants(t, open(t)) })
	t.Run("MissingBlob", func(t *testing.T) { testMissingBlob(t, open(t)) })
	t.Run("BadPaths", func(t *testing.T) { testBadPaths(t, open(t)) })
	t.Run("Delete", func(t *testing.T) { testDelete(t, open(t)) })
	t.Run("SkillFrontmatter", func(t *testing.T) { testSkills(t, open(t)) })
	t.Run("ListBundles", func(t *testing.T) { testList(t, open(t)) })
	t.Run("Units", func(t *testing.T) { testUnits(t, open(t)) })
}

func testBlobs(t *testing.T, b server.Backend) {
	data := []byte("hello world")
	id := sha(data)
	missing, err := b.HasBlobs("", []string{id})
	if err != nil || len(missing) != 1 || missing[0] != id {
		t.Fatalf("HasBlobs before put: missing=%v err=%v", missing, err)
	}
	if err := b.PutBlob("", id, bytes.NewReader(data), int64(len(data))); err != nil {
		t.Fatal(err)
	}
	// Idempotent re-put.
	if err := b.PutBlob("", id, bytes.NewReader(data), int64(len(data))); err != nil {
		t.Fatalf("second PutBlob: %v", err)
	}
	missing, err = b.HasBlobs("", []string{id, sha([]byte("other"))})
	if err != nil || len(missing) != 1 || missing[0] != sha([]byte("other")) {
		t.Fatalf("HasBlobs after put: missing=%v err=%v", missing, err)
	}
	rc, err := b.OpenBlob("", id)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if !bytes.Equal(got, data) {
		t.Fatalf("OpenBlob = %q", got)
	}
	// Hash mismatch is rejected and leaves nothing behind.
	bad := sha([]byte("not this"))
	if err := b.PutBlob("", bad, bytes.NewReader(data), int64(len(data))); err == nil {
		t.Fatal("hash mismatch accepted")
	}
	if missing, _ := b.HasBlobs("", []string{bad}); len(missing) != 1 {
		t.Fatal("rejected blob became visible")
	}
	// Size mismatch is rejected.
	other := []byte("zzz")
	if err := b.PutBlob("", sha(other), bytes.NewReader(other), 99); err == nil {
		t.Fatal("size mismatch accepted")
	}
	// Bad sha strings are rejected.
	if err := b.PutBlob("", "nothex", bytes.NewReader(data), int64(len(data))); err == nil {
		t.Fatal("invalid sha accepted")
	}
	if _, err := b.OpenBlob("", sha([]byte("never"))); err == nil {
		t.Fatal("OpenBlob of unknown blob succeeded")
	}
}

func testVersioning(t *testing.T, b server.Backend) {
	k := server.BundleKey{Scope: "user", Agent: "claude", Name: "CLAUDE.md"}
	f1 := putBlob(t, b, "", "CLAUDE.md", "# one")

	if _, ok := b.GetBundle("", k, 0); ok {
		t.Fatal("GetBundle on empty store returned a bundle")
	}

	v1, err := b.PutBundle("", k, api.Bundle{Parent: 0, Host: "h", Author: "me", Files: []api.BundleFile{f1}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if v1.Version != 1 || v1.Scope != "user" || v1.Agent != "claude" || v1.Name != "CLAUDE.md" || v1.Created.IsZero() {
		t.Fatalf("v1 = %+v", v1)
	}
	if v1.Skills == nil || v1.Files == nil {
		t.Fatal("Files/Skills should be non-nil slices")
	}

	// Wrong parent -> ErrStale.
	f2 := putBlob(t, b, "", "CLAUDE.md", "# two")
	_, err = b.PutBundle("", k, api.Bundle{Parent: 0, Files: []api.BundleFile{f2}}, false)
	if !errors.Is(err, server.ErrStale) {
		t.Fatalf("expected ErrStale, got %v", err)
	}
	if got, _ := b.GetBundle("", k, 0); got.Version != 1 {
		t.Fatalf("stale write changed HEAD: %+v", got)
	}
	// Correct parent advances.
	v2, err := b.PutBundle("", k, api.Bundle{Parent: 1, Files: []api.BundleFile{f2}}, false)
	if err != nil || v2.Version != 2 {
		t.Fatalf("v2 = %+v err=%v", v2, err)
	}
	// Force ignores parent.
	v3, err := b.PutBundle("", k, api.Bundle{Parent: 0, Files: []api.BundleFile{f1}}, true)
	if err != nil || v3.Version != 3 || v3.Parent != 0 {
		t.Fatalf("forced v3 = %+v err=%v", v3, err)
	}

	// Version 0 = HEAD; explicit versions resolve; unknown versions do not.
	head, ok := b.GetBundle("", k, 0)
	if !ok || head.Version != 3 {
		t.Fatalf("HEAD = %+v ok=%v", head, ok)
	}
	old, ok := b.GetBundle("", k, 2)
	if !ok || old.Version != 2 || old.Files[0].SHA256 != f2.SHA256 {
		t.Fatalf("v2 = %+v ok=%v", old, ok)
	}
	if _, ok := b.GetBundle("", k, 4); ok {
		t.Fatal("future version found")
	}
	// Key fields come from the key, not the body.
	if _, err := b.PutBundle("", k, api.Bundle{Scope: "org", Agent: "x", Name: "other", Parent: 3}, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := b.GetBundle("", k, 0); got.Scope != "user" || got.Agent != "claude" || got.Name != "CLAUDE.md" || got.Version != 4 {
		t.Fatalf("body overrode key: %+v", got)
	}
	// Invalid keys are rejected.
	if _, err := b.PutBundle("", server.BundleKey{Scope: "nope", Agent: "claude", Name: "x"}, api.Bundle{}, false); err == nil {
		t.Fatal("invalid scope accepted")
	}
	if _, err := b.PutBundle("", server.BundleKey{Scope: "user", Agent: "../x", Name: "x"}, api.Bundle{}, false); err == nil {
		t.Fatal("traversal agent accepted")
	}
	if _, err := b.PutBundle("", server.BundleKey{Scope: "project", Agent: "claude", Name: "x"}, api.Bundle{}, false); err == nil {
		t.Fatal("project scope without project accepted")
	}
	for _, name := range []string{"", "/abs", "../x", "a/../b", "a/./b", "./a", "a//b", "a/", `a\b`, "C:/x", "a/b/c/d", "a\nb"} {
		if _, err := b.PutBundle("", server.BundleKey{Scope: "user", Agent: "claude", Name: name}, api.Bundle{}, false); err == nil {
			t.Errorf("unit name %q accepted", name)
		}
	}
	for _, name := range []string{"CLAUDE.md", "skills/a", ".claude/skills/a", "commands/fix-tests"} {
		if _, err := b.PutBundle("", server.BundleKey{Scope: "user", Agent: "claude", Name: name}, api.Bundle{}, true); err != nil {
			t.Errorf("unit name %q rejected: %v", name, err)
		}
	}
}

func testHistory(t *testing.T, b server.Backend) {
	k := server.BundleKey{Scope: "project", Agent: "claude", Project: "/home/me/app", Name: ".claude/CLAUDE.md"}
	if got := b.BundleHistory("", k); len(got) != 0 {
		t.Fatalf("history of unknown bundle = %+v", got)
	}
	for i := 0; i < 3; i++ {
		f := putBlob(t, b, "", "CLAUDE.md", strings.Repeat("x", i+1))
		if _, err := b.PutBundle("", k, api.Bundle{Parent: i, Files: []api.BundleFile{f}}, false); err != nil {
			t.Fatal(err)
		}
	}
	h := b.BundleHistory("", k)
	if len(h) != 3 {
		t.Fatalf("history len = %d", len(h))
	}
	for i, want := range []int{3, 2, 1} {
		if h[i].Version != want || h[i].Project != k.Project || h[i].Name != k.Name {
			t.Fatalf("history[%d] = %+v, want version %d", i, h[i], want)
		}
	}
}

func testTenants(t *testing.T, b server.Backend) {
	data := []byte("shared content")
	id := sha(data)
	if err := b.PutBlob("orgA", id, bytes.NewReader(data), int64(len(data))); err != nil {
		t.Fatal(err)
	}
	// Blob is invisible to other tenants.
	if missing, _ := b.HasBlobs("orgB", []string{id}); len(missing) != 1 {
		t.Fatal("blob leaked across tenants")
	}
	if missing, _ := b.HasBlobs("", []string{id}); len(missing) != 1 {
		t.Fatal("blob leaked to default tenant")
	}
	if _, err := b.OpenBlob("orgB", id); err == nil {
		t.Fatal("OpenBlob across tenants succeeded")
	}

	k := server.BundleKey{Scope: "user", Agent: "claude", Name: "CLAUDE.md"}
	f := api.BundleFile{Path: "CLAUDE.md", SHA256: id, Size: int64(len(data))}
	if _, err := b.PutBundle("orgA", k, api.Bundle{Files: []api.BundleFile{f}}, false); err != nil {
		t.Fatal(err)
	}
	// orgB cannot reference orgA's blob, and sees no bundle.
	if _, err := b.PutBundle("orgB", k, api.Bundle{Files: []api.BundleFile{f}}, false); !errors.Is(err, server.ErrMissingBlob) {
		t.Fatalf("expected ErrMissingBlob across tenants, got %v", err)
	}
	if _, ok := b.GetBundle("orgB", k, 0); ok {
		t.Fatal("bundle leaked across tenants")
	}
	if _, ok := b.GetBundle("", k, 0); ok {
		t.Fatal("bundle leaked to default tenant")
	}
	if got := b.ListBundles("orgB", server.BundleFilter{}); len(got) != 0 {
		t.Fatalf("orgB list = %+v", got)
	}
	// Independent version counters.
	putBlob(t, b, "orgB", "CLAUDE.md", "shared content")
	vb, err := b.PutBundle("orgB", k, api.Bundle{Files: []api.BundleFile{f}}, false)
	if err != nil || vb.Version != 1 {
		t.Fatalf("orgB v = %+v err=%v", vb, err)
	}
	if err := b.DeleteBundle("orgB", k); err != nil {
		t.Fatal(err)
	}
	if _, ok := b.GetBundle("orgA", k, 0); !ok {
		t.Fatal("deleting orgB's bundle removed orgA's")
	}
	// Invalid tenant names are rejected.
	if err := b.PutBlob("../x", id, bytes.NewReader(data), int64(len(data))); err == nil {
		t.Fatal("invalid tenant accepted by PutBlob")
	}
	if _, err := b.PutBundle("../x", k, api.Bundle{}, false); err == nil {
		t.Fatal("invalid tenant accepted by PutBundle")
	}
}

func testMissingBlob(t *testing.T, b server.Backend) {
	k := server.BundleKey{Scope: "user", Agent: "claude", Name: "skills/x"}
	have := putBlob(t, b, "", "a.md", "a")
	ghost := api.BundleFile{Path: "b.md", SHA256: sha([]byte("never uploaded")), Size: 14}
	_, err := b.PutBundle("", k, api.Bundle{Files: []api.BundleFile{have, ghost}}, false)
	if !errors.Is(err, server.ErrMissingBlob) {
		t.Fatalf("expected ErrMissingBlob, got %v", err)
	}
	if _, ok := b.GetBundle("", k, 0); ok {
		t.Fatal("rejected bundle was stored")
	}
	// Empty bundle (no files) is fine.
	if _, err := b.PutBundle("", k, api.Bundle{}, false); err != nil {
		t.Fatal(err)
	}
}

func testBadPaths(t *testing.T, b server.Backend) {
	k := server.BundleKey{Scope: "user", Agent: "claude", Name: "skills/x"}
	ok := putBlob(t, b, "", "ok.md", "ok")
	for _, p := range []string{"", "/abs.md", "../up.md", "a/../b.md", "a/./b.md", "./a.md", "a//b.md", "a/b/", `a\b.md`, "C:/x.md"} {
		f := ok
		f.Path = p
		if _, err := b.PutBundle("", k, api.Bundle{Files: []api.BundleFile{f}}, false); err == nil {
			t.Errorf("path %q accepted", p)
		}
	}
	// Duplicate paths and bad hashes are rejected.
	if _, err := b.PutBundle("", k, api.Bundle{Files: []api.BundleFile{ok, ok}}, false); err == nil {
		t.Error("duplicate path accepted")
	}
	bad := ok
	bad.SHA256 = "xyz"
	if _, err := b.PutBundle("", k, api.Bundle{Files: []api.BundleFile{bad}}, false); err == nil {
		t.Error("bad sha accepted")
	}
	if _, ok := b.GetBundle("", k, 0); ok {
		t.Fatal("a rejected bundle was stored")
	}
	// Nested valid paths work.
	f := ok
	f.Path = "scripts/review/run.sh"
	if _, err := b.PutBundle("", k, api.Bundle{Files: []api.BundleFile{f}}, false); err != nil {
		t.Fatal(err)
	}
}

func testDelete(t *testing.T, b server.Backend) {
	k := server.BundleKey{Scope: "org", Agent: "claude", Name: "CLAUDE.md"}
	if err := b.DeleteBundle("", k); err == nil {
		t.Fatal("deleting unknown bundle succeeded")
	}
	f := putBlob(t, b, "", "CLAUDE.md", "x")
	for i := 0; i < 2; i++ {
		if _, err := b.PutBundle("", k, api.Bundle{Parent: i, Files: []api.BundleFile{f}}, false); err != nil {
			t.Fatal(err)
		}
	}
	if err := b.DeleteBundle("", k); err != nil {
		t.Fatal(err)
	}
	if _, ok := b.GetBundle("", k, 0); ok {
		t.Fatal("bundle still visible after delete")
	}
	if _, ok := b.GetBundle("", k, 1); ok {
		t.Fatal("old version still visible after delete")
	}
	if got := b.BundleHistory("", k); len(got) != 0 {
		t.Fatalf("history after delete = %+v", got)
	}
	if got := b.ListBundles("", server.BundleFilter{}); len(got) != 0 {
		t.Fatalf("list after delete = %+v", got)
	}
	// Blobs survive (content-addressed; gc is separate).
	if missing, _ := b.HasBlobs("", []string{f.SHA256}); len(missing) != 0 {
		t.Fatal("delete removed a blob")
	}
	// Versioning restarts from 1 after delete.
	v, err := b.PutBundle("", k, api.Bundle{Parent: 0, Files: []api.BundleFile{f}}, false)
	if err != nil || v.Version != 1 {
		t.Fatalf("after delete v = %+v err=%v", v, err)
	}
}

func testSkills(t *testing.T, b server.Backend) {
	// A skill unit has its SKILL.md at the unit root; nested SKILL.md files
	// (sub-skills) are parsed too, other markdown is not.
	k := server.BundleKey{Scope: "user", Agent: "claude", Name: "skills/review"}
	s1 := putBlob(t, b, "", "SKILL.md", "---\nname: review\ndescription: \"Review a diff: carefully\"\nother: x\n---\n# Body\nname: not-this\n")
	s2 := putBlob(t, b, "", "deploy/SKILL.md", "# No frontmatter\nname: nope\n")
	s3 := putBlob(t, b, "", "zz/SKILL.md", "---\ndescription: 'single quoted'\n---\n")
	notSkill := putBlob(t, b, "", "README.md", "---\nname: readme\n---\n")
	v, err := b.PutBundle("", k, api.Bundle{Files: []api.BundleFile{s3, notSkill, s1, s2}}, false)
	if err != nil {
		t.Fatal(err)
	}
	want := []api.SkillMeta{
		{Path: "SKILL.md", Name: "review", Description: "Review a diff: carefully"},
		{Path: "deploy/SKILL.md"},
		{Path: "zz/SKILL.md", Description: "single quoted"},
	}
	if len(v.Skills) != len(want) {
		t.Fatalf("skills = %+v", v.Skills)
	}
	for i := range want {
		if v.Skills[i] != want[i] {
			t.Errorf("skills[%d] = %+v, want %+v", i, v.Skills[i], want[i])
		}
	}
	// Persisted, not just returned.
	got, _ := b.GetBundle("", k, 0)
	if len(got.Skills) != 3 || got.Skills[0].Name != "review" {
		t.Fatalf("stored skills = %+v", got.Skills)
	}
}

func testList(t *testing.T, b server.Backend) {
	f := putBlob(t, b, "", "CLAUDE.md", "c")
	keys := []server.BundleKey{
		{Scope: "user", Agent: "claude", Name: "CLAUDE.md"},
		{Scope: "user", Agent: "claude", Name: "skills/a"},
		{Scope: "user", Agent: "codex", Name: "AGENTS.md"},
		{Scope: "project", Agent: "claude", Project: "/p1", Name: "CLAUDE.md"},
		{Scope: "project", Agent: "claude", Project: "/p2", Name: "CLAUDE.md"},
		{Scope: "org", Agent: "claude", Name: "skills/a"},
	}
	for _, k := range keys {
		if _, err := b.PutBundle("", k, api.Bundle{Files: []api.BundleFile{f}}, false); err != nil {
			t.Fatal(err)
		}
	}
	// Bump one so HEADs (not v1) are listed.
	if _, err := b.PutBundle("", keys[0], api.Bundle{Parent: 1}, false); err != nil {
		t.Fatal(err)
	}
	all := b.ListBundles("", server.BundleFilter{})
	if len(all) != 6 {
		t.Fatalf("list all = %d", len(all))
	}
	for _, x := range all {
		if x.Scope == "user" && x.Agent == "claude" && x.Name == "CLAUDE.md" && x.Version != 2 {
			t.Fatalf("list returned non-HEAD: %+v", x)
		}
		if x.Scope == "user" && x.Agent == "claude" && x.Name == "skills/a" && x.Version != 1 {
			t.Fatalf("sibling unit was bumped: %+v", x)
		}
	}
	// Sorted by scope, agent, project, name.
	if all[0].Scope != "org" || all[1].Project != "/p1" || all[3].Name != "CLAUDE.md" || all[4].Name != "skills/a" || all[5].Agent != "codex" {
		t.Fatalf("list order = %+v", all)
	}
	if got := b.ListBundles("", server.BundleFilter{Name: "skills/a"}); len(got) != 2 {
		t.Fatalf("name filter = %+v", got)
	}
	if got := b.ListBundles("", server.BundleFilter{Scope: "org", Name: "skills/a"}); len(got) != 1 || got[0].Scope != "org" {
		t.Fatalf("scope+name filter = %+v", got)
	}
	if got := b.ListBundles("", server.BundleFilter{Scope: "project"}); len(got) != 2 {
		t.Fatalf("scope filter = %+v", got)
	}
	if got := b.ListBundles("", server.BundleFilter{Agent: "codex"}); len(got) != 1 || got[0].Agent != "codex" {
		t.Fatalf("agent filter = %+v", got)
	}
	if got := b.ListBundles("", server.BundleFilter{Scope: "project", Project: "/p2"}); len(got) != 1 || got[0].Project != "/p2" {
		t.Fatalf("project filter = %+v", got)
	}
}

// testUnits checks that units in one (scope, agent, project) are fully
// independent: separate version counters, histories and deletion, including
// when one unit's name is a path prefix of another's.
func testUnits(t *testing.T, b server.Backend) {
	mk := func(name string) server.BundleKey {
		return server.BundleKey{Scope: "user", Agent: "claude", Name: name}
	}
	a, bb, nested, top := mk("skills/a"), mk("skills/b"), mk("skills/a/sub"), mk("skills")
	f := putBlob(t, b, "", "SKILL.md", "---\nname: a\n---\n")
	for i := 0; i < 3; i++ {
		if _, err := b.PutBundle("", a, api.Bundle{Parent: i, Files: []api.BundleFile{f}}, false); err != nil {
			t.Fatal(err)
		}
	}
	for _, k := range []server.BundleKey{bb, nested, top} {
		v, err := b.PutBundle("", k, api.Bundle{Files: []api.BundleFile{f}}, false)
		if err != nil || v.Version != 1 || v.Name != k.Name {
			t.Fatalf("%s: v=%+v err=%v", k.Name, v, err)
		}
	}
	if got, _ := b.GetBundle("", a, 0); got.Version != 3 {
		t.Fatalf("skills/a moved: %+v", got)
	}
	if h := b.BundleHistory("", bb); len(h) != 1 || h[0].Name != "skills/b" {
		t.Fatalf("skills/b history = %+v", h)
	}
	if h := b.BundleHistory("", a); len(h) != 3 {
		t.Fatalf("skills/a history = %+v", h)
	}
	// Stale detection is per unit.
	if _, err := b.PutBundle("", bb, api.Bundle{Parent: 3, Files: []api.BundleFile{f}}, false); !errors.Is(err, server.ErrStale) {
		t.Fatalf("expected ErrStale for skills/b parent 3, got %v", err)
	}
	// Deleting a prefix unit keeps the units nested below it, and vice versa.
	if err := b.DeleteBundle("", top); err != nil {
		t.Fatal(err)
	}
	for _, k := range []server.BundleKey{a, bb, nested} {
		if _, ok := b.GetBundle("", k, 0); !ok {
			t.Fatalf("deleting %q removed %q", top.Name, k.Name)
		}
	}
	if err := b.DeleteBundle("", a); err != nil {
		t.Fatal(err)
	}
	if _, ok := b.GetBundle("", nested, 0); !ok {
		t.Fatal("deleting skills/a removed skills/a/sub")
	}
	if _, ok := b.GetBundle("", a, 0); ok {
		t.Fatal("skills/a still present")
	}
	if got := b.ListBundles("", server.BundleFilter{Scope: "user"}); len(got) != 2 {
		t.Fatalf("list after deletes = %+v", got)
	}
	// Versioning of the deleted unit restarts; siblings unaffected.
	if v, err := b.PutBundle("", a, api.Bundle{Files: []api.BundleFile{f}}, false); err != nil || v.Version != 1 {
		t.Fatalf("recreate skills/a: %+v %v", v, err)
	}
	if got, _ := b.GetBundle("", nested, 0); got.Version != 1 {
		t.Fatalf("nested = %+v", got)
	}
}
