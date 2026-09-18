package skillsync

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stift-sh/stift/internal/api"
	"github.com/stift-sh/stift/internal/client"
	"github.com/stift-sh/stift/internal/registry"
)

// registryServer serves `@acme/deploy` the way the public registry does:
// versions by number, blobs only through a version's scoped route. tamper
// makes the blob route return the wrong bytes for that sha.
func registryServer(t *testing.T, versions map[int]string, tamper map[string]string) (*httptest.Server, map[string]string) {
	t.Helper()
	shas := map[string]string{}
	byHash := map[string]string{}
	for _, c := range versions {
		h := sha256.Sum256([]byte(c))
		s := hex.EncodeToString(h[:])
		shas[c], byHash[s] = s, c
	}
	latest := 0
	for v := range versions {
		if v > latest {
			latest = v
		}
	}
	skill := api.PublishedSkill{Org: "acme", Name: "deploy", Agent: "claude", Unit: "skills/deploy", License: "MIT", Latest: latest}
	version := func(v int) api.PublishedVersion {
		c := versions[v]
		return api.PublishedVersion{Org: "acme", Name: "deploy", Version: v, SourceVersion: v, Files: []api.BundleFile{{Path: "SKILL.md", Sha256: shas[c], Size: len(c), Mode: 0o644}}}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("registry request carried a token: %s", r.URL)
		}
		const prefix = "/v1/registry/skills/@acme/deploy"
		if !strings.Contains(r.URL.Path, "/blobs/") {
			w.Header().Set("Content-Type", "application/json")
		}
		if r.URL.Path == "/api/version" {
			json.NewEncoder(w).Encode(api.Version{API: 1, Version: "test", Features: []string{"registry"}})
			return
		}
		if !strings.HasPrefix(r.URL.Path, prefix) {
			http.NotFound(w, r)
			return
		}
		rest := strings.TrimPrefix(r.URL.Path, prefix)
		switch {
		case rest == "":
			json.NewEncoder(w).Encode(api.RegistrySkill{Skill: skill, Version: version(latest)})
		case strings.Contains(rest, "/blobs/"):
			parts := strings.Split(rest, "/") // "", v, "blobs", sha
			v, sha := parts[1], parts[3]
			c, ok := byHash[sha]
			if !ok || shas[versions[atoi(v)]] != sha {
				http.NotFound(w, r)
				return
			}
			if bad, ok := tamper[sha]; ok {
				c = bad
			}
			w.Write([]byte(c))
		default:
			v := atoi(strings.TrimPrefix(rest, "/"))
			if _, ok := versions[v]; !ok {
				http.NotFound(w, r)
				return
			}
			json.NewEncoder(w).Encode(api.RegistrySkill{Skill: skill, Version: version(v)})
		}
	}))
	t.Cleanup(srv.Close)
	return srv, shas
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}

func TestInstallRegistryVerifiesAndUpgrades(t *testing.T) {
	srv, _ := registryServer(t, map[int]string{1: "v1", 2: "v2"}, nil)
	s := testSyncer(t, srv)
	s.Client, s.Server = nil, "" // no login
	reg := client.NewRegistry(srv.URL)
	ref, _ := registry.Parse("@acme/deploy@1")
	dir := filepath.Join(s.Home, ".claude", "skills", "deploy")

	rs, err := reg.Get(ref.Org, ref.Name, ref.Version)
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.InstallRegistry("claude", reg, ref, rs, InstallOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Dir != dir || res.Version != 1 || len(res.Apply.Written) != 1 {
		t.Fatalf("unexpected result %+v", res)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "SKILL.md")); string(b) != "v1" {
		t.Fatalf("content %q", b)
	}
	e := s.State.GetInstall(srv.URL, "claude", "@acme/deploy")
	if e.From != "registry" || e.Version != 1 || e.Ref != "@acme/deploy" || e.Registry != srv.URL || e.Unit != "skills/deploy" {
		t.Fatalf("state %+v", e)
	}
	if _, _, found := s.State.FindInstall("claude", "skills/deploy"); !found {
		t.Fatal("FindInstall should see the registry install under its unit")
	}

	// latest is v2: plain install refuses, --upgrade applies.
	latest, err := reg.Get(ref.Org, ref.Name, 0)
	if err != nil || latest.Version.Version != 2 {
		t.Fatalf("latest: %+v %v", latest, err)
	}
	if _, err := s.InstallRegistry("claude", reg, ref, latest, InstallOptions{}); err == nil || !strings.Contains(err.Error(), "already installed") {
		t.Fatalf("expected refusal, got %v", err)
	}
	res, err = s.InstallRegistry("claude", reg, ref, latest, InstallOptions{Upgrade: true})
	if err != nil || !res.Upgraded || res.Previous != 1 || res.Version != 2 {
		t.Fatalf("upgrade: %+v %v", res, err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "SKILL.md")); string(b) != "v2" {
		t.Fatalf("content %q", b)
	}
	os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("mine"), 0o644)
	if _, err := s.InstallRegistry("claude", reg, ref, latest, InstallOptions{Upgrade: true}); err == nil || !strings.Contains(err.Error(), "modified locally") {
		t.Fatalf("expected ErrModified, got %v", err)
	}
}

func TestInstallRegistryRejectsTamperedBlob(t *testing.T) {
	good := "v1"
	h := sha256.Sum256([]byte(good))
	sha := hex.EncodeToString(h[:])
	srv, _ := registryServer(t, map[int]string{1: good}, map[string]string{sha: "evil"})
	s := testSyncer(t, srv)
	reg := client.NewRegistry(srv.URL)
	ref, _ := registry.Parse("@acme/deploy")
	rs, err := reg.Get(ref.Org, ref.Name, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.InstallRegistry("claude", reg, ref, rs, InstallOptions{})
	if err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("expected a checksum failure, got %v", err)
	}
	dir := filepath.Join(s.Home, ".claude", "skills", "deploy")
	if _, err := os.Stat(filepath.Join(dir, "SKILL.md")); !os.IsNotExist(err) {
		t.Fatal("a tampered blob must not be written")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("temp files left behind: %v", entries)
	}
	if e := s.State.GetInstall(srv.URL, "claude", "@acme/deploy"); e.Version != 0 {
		t.Fatalf("state must not record a failed install: %+v", e)
	}
}

func TestInstallRegistryCollidesWithOrgInstall(t *testing.T) {
	// One server plays both roles: org blobs at /v1/blobs, registry at /v1/registry.
	regSrv, _ := registryServer(t, map[int]string{1: "public"}, nil)
	orgSrv, orgShas := blobServer(t, "internal")
	s := testSyncer(t, orgSrv)
	reg := client.NewRegistry(regSrv.URL)
	ref, _ := registry.Parse("@acme/deploy")
	dir := filepath.Join(s.Home, ".claude", "skills", "deploy")

	if _, err := s.Install("claude", skill(0, 1, "internal", orgShas["internal"]), InstallOptions{}); err != nil {
		t.Fatal(err)
	}
	rs, _ := reg.Get(ref.Org, ref.Name, 0)
	_, err := s.InstallRegistry("claude", reg, ref, rs, InstallOptions{})
	if err == nil || !strings.Contains(err.Error(), "already installed from org") {
		t.Fatalf("expected the collision refusal, got %v", err)
	}
	res, err := s.InstallRegistry("claude", reg, ref, rs, InstallOptions{Force: true})
	if err != nil || res.Evicted != "org" {
		t.Fatalf("force: %+v %v", res, err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "SKILL.md")); string(b) != "public" {
		t.Fatalf("content %q", b)
	}
	if e := s.State.GetInstall(orgSrv.URL, "claude", "skills/deploy"); e.Version != 0 {
		t.Fatalf("org entry should be gone: %+v", e)
	}
	// And back: the org install now collides with the registry one.
	_, err = s.Install("claude", skill(0, 1, "internal", orgShas["internal"]), InstallOptions{})
	if err == nil || !strings.Contains(err.Error(), "already installed from @acme/deploy") {
		t.Fatalf("expected the reverse collision, got %v", err)
	}
	res, err = s.Install("claude", skill(0, 1, "internal", orgShas["internal"]), InstallOptions{Force: true})
	if err != nil || res.Evicted != "@acme/deploy" {
		t.Fatalf("force back: %+v %v", res, err)
	}
	if _, e, found := s.State.FindInstall("claude", "skills/deploy"); !found || e.From != "org" {
		t.Fatalf("state after force back: %+v %v", e, found)
	}
}
