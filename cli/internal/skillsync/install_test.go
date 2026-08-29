package skillsync

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stift-sh/stift/internal/api"
	"github.com/stift-sh/stift/internal/bundle"
	"github.com/stift-sh/stift/internal/client"
)

// blobServer serves content-addressed blobs the way the real server does.
func blobServer(t *testing.T, contents ...string) (*httptest.Server, map[string]string) {
	t.Helper()
	shas := map[string]string{} // content -> sha
	byHash := map[string]string{}
	for _, c := range contents {
		h := sha256.Sum256([]byte(c))
		s := hex.EncodeToString(h[:])
		shas[c], byHash[s] = s, c
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sha := strings.TrimPrefix(r.URL.Path, "/v1/blobs/")
		if c, ok := byHash[sha]; ok {
			w.Write([]byte(c))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, shas
}

func testSyncer(t *testing.T, srv *httptest.Server) *Syncer {
	t.Helper()
	home := t.TempDir()
	t.Setenv("STIFT_SKILLS_STATE", filepath.Join(home, "state.json"))
	st, err := bundle.LoadState()
	if err != nil {
		t.Fatal(err)
	}
	return &Syncer{Client: client.New(srv.URL, "stf_x"), State: st, Server: srv.URL, Home: home, Host: "h", Warn: func(string) {}}
}

func skill(name, version int, content, sha string) api.Bundle {
	return api.Bundle{Scope: "org", Agent: "claude", Name: "skills/deploy", Version: version, Files: []api.BundleFile{{Path: "SKILL.md", Sha256: sha, Size: len(content), Mode: 0o644}}}
}

func TestInstallCopiesAndUpgrades(t *testing.T) {
	srv, shas := blobServer(t, "v1", "v2")
	s := testSyncer(t, srv)
	dir := filepath.Join(s.Home, ".claude", "skills", "deploy")

	res, err := s.Install("claude", skill(0, 1, "v1", shas["v1"]), InstallOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Dir != dir || len(res.Apply.Written) != 1 {
		t.Fatalf("unexpected result %+v", res)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "SKILL.md")); string(b) != "v1" {
		t.Fatalf("content %q", b)
	}
	if fi, err := os.Lstat(dir); err != nil || fi.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("install must be a real directory: %v %v", fi, err)
	}
	if e := s.State.GetInstall(s.Server, "claude", "skills/deploy"); e.Version != 1 || e.From != "org" {
		t.Fatalf("state %+v", e)
	}

	// A second plain install is refused; --upgrade re-copies.
	if _, err := s.Install("claude", skill(0, 2, "v2", shas["v2"]), InstallOptions{}); err == nil || !strings.Contains(err.Error(), "already installed") {
		t.Fatalf("expected refusal, got %v", err)
	}
	res, err = s.Install("claude", skill(0, 2, "v2", shas["v2"]), InstallOptions{Upgrade: true})
	if err != nil || !res.Upgraded || res.Previous != 1 {
		t.Fatalf("upgrade: %+v %v", res, err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "SKILL.md")); string(b) != "v2" {
		t.Fatalf("content %q", b)
	}

	// Local edits block an upgrade unless forced.
	os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("mine"), 0o644)
	if _, err := s.Install("claude", skill(0, 2, "v2", shas["v2"]), InstallOptions{Upgrade: true}); !errors.Is(err, ErrModified) {
		t.Fatalf("expected ErrModified, got %v", err)
	}
	if _, err := s.Install("claude", skill(0, 2, "v2", shas["v2"]), InstallOptions{Upgrade: true, Force: true}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "SKILL.md")); string(b) != "v2" {
		t.Fatalf("content after force %q", b)
	}
}

func TestInstallRefusesSubscriptionUnlessReplace(t *testing.T) {
	srv, shas := blobServer(t, "v1")
	s := testSyncer(t, srv)
	mirror := filepath.Join(OrgDir(s.Home, "claude"), "skills", "deploy")
	os.MkdirAll(mirror, 0o755)
	os.WriteFile(filepath.Join(mirror, "SKILL.md"), []byte("v1"), 0o644)
	link := filepath.Join(s.Home, ".claude", "skills", "deploy")
	os.MkdirAll(filepath.Dir(link), 0o755)
	if err := os.Symlink(mirror, link); err != nil {
		t.Fatal(err)
	}

	if _, err := s.Install("claude", skill(0, 1, "v1", shas["v1"]), InstallOptions{}); !errors.Is(err, ErrSubscribed) {
		t.Fatalf("expected ErrSubscribed, got %v", err)
	}
	res, err := s.Install("claude", skill(0, 1, "v1", shas["v1"]), InstallOptions{Replace: true})
	if err != nil || !res.Replaced {
		t.Fatalf("replace: %+v %v", res, err)
	}
	if fi, _ := os.Lstat(link); fi == nil || fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		t.Fatalf("expected a real directory after --replace")
	}
	if b, _ := os.ReadFile(filepath.Join(link, "SKILL.md")); string(b) != "v1" {
		t.Fatalf("content %q", b)
	}
	// A foreign symlink is never touched.
	other := filepath.Join(s.Home, "elsewhere")
	os.MkdirAll(other, 0o755)
	os.RemoveAll(link)
	os.Symlink(other, link)
	if _, err := s.Install("claude", skill(0, 1, "v1", shas["v1"]), InstallOptions{Replace: true, Force: true}); err == nil || !strings.Contains(err.Error(), "remove it first") {
		t.Fatalf("expected foreign-link refusal, got %v", err)
	}
}

func TestInstallRejectsTopLevelUnit(t *testing.T) {
	srv, _ := blobServer(t)
	s := testSyncer(t, srv)
	if _, err := s.Install("claude", api.Bundle{Name: "CLAUDE.md", Version: 1}, InstallOptions{}); err == nil {
		t.Fatal("expected error for a top-level unit")
	}
}
