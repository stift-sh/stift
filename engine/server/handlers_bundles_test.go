package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stift-sh/stift/engine/api"
)

func shaOf(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func decodeJSON(t *testing.T, res *http.Response, out any) {
	t.Helper()
	defer res.Body.Close()
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		t.Fatal(err)
	}
}

func putBlob(t *testing.T, ts *httptest.Server, token string, content []byte) string {
	t.Helper()
	sha := shaOf(content)
	res := request(t, http.MethodPut, ts.URL+"/v1/blobs/"+sha, token, bytes.NewReader(content), "application/octet-stream")
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("put blob: %s: %s", res.Status, b)
	}
	return sha
}

func putBundle(t *testing.T, ts *httptest.Server, token, path string, b api.Bundle) *http.Response {
	t.Helper()
	body, _ := json.Marshal(b)
	return request(t, http.MethodPut, ts.URL+path, token, bytes.NewReader(body), "application/json")
}

func TestBundlePushFlow(t *testing.T) {
	ts, admin := newTestServer(t)
	skill := []byte("---\nname: hello\ndescription: says hi\n---\n# Hello\n")
	claude := []byte("# CLAUDE.md\n")
	shas := []string{shaOf(skill), shaOf(claude)}

	// check: nothing uploaded yet.
	body, _ := json.Marshal(map[string][]string{"shas": shas})
	res := request(t, http.MethodPost, ts.URL+"/v1/blobs/check", admin, bytes.NewReader(body), "application/json")
	var check struct{ Missing []string }
	decodeJSON(t, res, &check)
	if len(check.Missing) != 2 {
		t.Fatalf("missing = %v, want both", check.Missing)
	}

	putBlob(t, ts, admin, skill)
	putBlob(t, ts, admin, skill) // idempotent
	putBlob(t, ts, admin, claude)

	res = request(t, http.MethodPost, ts.URL+"/v1/blobs/check", admin, bytes.NewReader(body), "application/json")
	decodeJSON(t, res, &check)
	if len(check.Missing) != 0 {
		t.Fatalf("missing after upload = %v", check.Missing)
	}

	// blob round-trip
	res = request(t, http.MethodGet, ts.URL+"/v1/blobs/"+shas[0], admin, nil, "")
	got, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !bytes.Equal(got, skill) || res.Header.Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("get blob: %s %q %q", res.Status, res.Header.Get("Content-Type"), got)
	}
	res = request(t, http.MethodGet, ts.URL+"/v1/blobs/"+strings.Repeat("0", 64), admin, nil, "")
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("get absent blob: %s", res.Status)
	}

	manifest := api.Bundle{Host: "h1", Files: []api.BundleFile{
		{Path: "SKILL.md", SHA256: shas[0], Size: int64(len(skill)), Mode: 0o644},
		{Path: "NOTES.md", SHA256: shas[1], Size: int64(len(claude)), Mode: 0o644},
	}}
	res = putBundle(t, ts, admin, "/v1/bundles/user/claude/skills/hello", manifest)
	if res.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("put bundle: %s: %s", res.Status, b)
	}
	var v1 api.Bundle
	decodeJSON(t, res, &v1)
	if v1.Version != 1 || v1.Scope != "user" || v1.Agent != "claude" || v1.Name != "skills/hello" || v1.Author != "admin" {
		t.Fatalf("v1 = %+v", v1)
	}
	if len(v1.Skills) != 1 || v1.Skills[0].Path != "SKILL.md" || v1.Skills[0].Name != "hello" || v1.Skills[0].Description != "says hi" {
		t.Fatalf("skills = %+v", v1.Skills)
	}

	// second version on top of v1
	manifest.Parent = 1
	manifest.Files = manifest.Files[:1]
	res = putBundle(t, ts, admin, "/v1/bundles/user/claude/skills/hello", manifest)
	defer res.Body.Close()
	var v2 api.Bundle
	decodeJSON(t, res, &v2)
	if v2.Version != 2 || v2.Parent != 1 {
		t.Fatalf("v2 = %+v", v2)
	}

	// get HEAD + explicit version
	var head, old api.Bundle
	decodeJSON(t, request(t, http.MethodGet, ts.URL+"/v1/bundles/user/claude/skills/hello", admin, nil, ""), &head)
	decodeJSON(t, request(t, http.MethodGet, ts.URL+"/v1/bundles/user/claude/skills/hello?version=1", admin, nil, ""), &old)
	if head.Version != 2 || old.Version != 1 || len(old.Files) != 2 {
		t.Fatalf("head=%d old=%d", head.Version, old.Version)
	}
	res = request(t, http.MethodGet, ts.URL+"/v1/bundles/user/codex/skills/hello", admin, nil, "")
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("get absent bundle: %s", res.Status)
	}

	// history newest first
	var hist []api.Bundle
	decodeJSON(t, request(t, http.MethodGet, ts.URL+"/v1/bundles/user/claude/skills/hello?history=1", admin, nil, ""), &hist)
	if len(hist) != 2 || hist[0].Version != 2 || hist[1].Version != 1 {
		t.Fatalf("history = %+v", hist)
	}

	// a second unit in the same scope versions independently
	other := api.Bundle{Files: []api.BundleFile{{Path: "CLAUDE.md", SHA256: shas[1], Size: int64(len(claude))}}}
	res = putBundle(t, ts, admin, "/v1/bundles/user/claude/CLAUDE.md", other)
	var o1 api.Bundle
	decodeJSON(t, res, &o1)
	if o1.Version != 1 || o1.Name != "CLAUDE.md" {
		t.Fatalf("other unit = %+v", o1)
	}
	decodeJSON(t, request(t, http.MethodGet, ts.URL+"/v1/bundles/user/claude/skills/hello", admin, nil, ""), &head)
	if head.Version != 2 {
		t.Fatalf("sibling write moved skills/hello to v%d", head.Version)
	}

	// list, optionally by name
	var list []api.Bundle
	decodeJSON(t, request(t, http.MethodGet, ts.URL+"/v1/bundles?scope=user", admin, nil, ""), &list)
	if len(list) != 2 || list[0].Name != "CLAUDE.md" || list[1].Name != "skills/hello" || list[1].Version != 2 {
		t.Fatalf("list = %+v", list)
	}
	decodeJSON(t, request(t, http.MethodGet, ts.URL+"/v1/bundles?scope=user&name=skills/hello", admin, nil, ""), &list)
	if len(list) != 1 || list[0].Name != "skills/hello" {
		t.Fatalf("list by name = %+v", list)
	}

	// bad names
	for _, bad := range []string{"a/b/c/d", "a%2F..%2Fx", "a.%00b"} {
		res = putBundle(t, ts, admin, "/v1/bundles/user/claude/"+bad, other)
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest && res.StatusCode != http.StatusNotFound {
			t.Fatalf("name %q: %s", bad, res.Status)
		}
	}
	res = request(t, http.MethodGet, ts.URL+"/v1/bundles/user/claude/a/b/c/d?history=1", admin, nil, "")
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("history of bad name: %s", res.Status)
	}
	res = request(t, http.MethodGet, ts.URL+"/v1/bundles/user/claude/skills/nope?history=1", admin, nil, "")
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("history of unknown unit: %s", res.Status)
	}

	// delete one unit; the other stays
	res = request(t, http.MethodDelete, ts.URL+"/v1/bundles/user/claude/skills/hello", admin, nil, "")
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %s", res.Status)
	}
	decodeJSON(t, request(t, http.MethodGet, ts.URL+"/v1/bundles", admin, nil, ""), &list)
	if len(list) != 1 || list[0].Name != "CLAUDE.md" {
		t.Fatalf("list after delete = %+v", list)
	}
}

func TestBundleStaleAndMissingBlob(t *testing.T) {
	ts, admin := newTestServer(t)
	content := []byte("hi\n")
	sha := putBlob(t, ts, admin, content)
	m := api.Bundle{Files: []api.BundleFile{{Path: "CLAUDE.md", SHA256: sha, Size: 3}}}

	res := putBundle(t, ts, admin, "/v1/bundles/user/claude/CLAUDE.md", m)
	res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("first put: %s", res.Status)
	}

	// parent 0 again -> stale
	res = putBundle(t, ts, admin, "/v1/bundles/user/claude/CLAUDE.md", m)
	var e api.Error
	code := res.StatusCode
	decodeJSON(t, res, &e)
	if code != http.StatusConflict || !strings.Contains(e.Error, "version 1") {
		t.Fatalf("stale: %d %q", code, e.Error)
	}

	// force overrides
	res = putBundle(t, ts, admin, "/v1/bundles/user/claude/CLAUDE.md?force=1", m)
	var forced api.Bundle
	decodeJSON(t, res, &forced)
	if forced.Version != 2 {
		t.Fatalf("forced = %+v", forced)
	}

	// missing blob -> 412 with the sha in the message
	missing := strings.Repeat("a", 64)
	m2 := api.Bundle{Parent: 2, Files: []api.BundleFile{{Path: "x.md", SHA256: missing, Size: 1}}}
	res = putBundle(t, ts, admin, "/v1/bundles/user/claude/CLAUDE.md", m2)
	code = res.StatusCode
	decodeJSON(t, res, &e)
	if code != http.StatusPreconditionFailed || !strings.Contains(e.Error, missing) {
		t.Fatalf("missing blob: %d %q", code, e.Error)
	}

	// validation -> 400
	m3 := api.Bundle{Parent: 2, Files: []api.BundleFile{{Path: "../etc/passwd", SHA256: sha, Size: 3}}}
	res = putBundle(t, ts, admin, "/v1/bundles/user/claude/CLAUDE.md", m3)
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad path: %s", res.Status)
	}
	res = putBundle(t, ts, admin, "/v1/bundles/project/claude/CLAUDE.md", m) // project without ?project=
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("project without path: %s", res.Status)
	}
}

func TestBundleOrgScopeRequiresAdmin(t *testing.T) {
	ts, admin := newTestServer(t)
	// Mint a non-admin token via the API.
	res := request(t, http.MethodPost, ts.URL+"/v1/tokens", admin,
		strings.NewReader(`{"name":"dev","admin":false}`), "application/json")
	var tok api.TokenCreated
	decodeJSON(t, res, &tok)
	user := tok.Token

	sha := putBlob(t, ts, user, []byte("org\n"))
	m := api.Bundle{Files: []api.BundleFile{{Path: "CLAUDE.md", SHA256: sha, Size: 4}}}

	res = putBundle(t, ts, user, "/v1/bundles/org/claude/CLAUDE.md", m)
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin org put: %s", res.Status)
	}
	res = putBundle(t, ts, admin, "/v1/bundles/org/claude/CLAUDE.md", m)
	res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("admin org put: %s", res.Status)
	}
	// members can read
	res = request(t, http.MethodGet, ts.URL+"/v1/bundles/org/claude/CLAUDE.md", user, nil, "")
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("member org get: %s", res.Status)
	}
	res = request(t, http.MethodDelete, ts.URL+"/v1/bundles/org/claude/CLAUDE.md", user, nil, "")
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin org delete: %s", res.Status)
	}
	// user scope is fine for non-admins
	res = putBundle(t, ts, user, "/v1/bundles/user/claude/CLAUDE.md", m)
	res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("non-admin user put: %s", res.Status)
	}
}

func TestBlobValidation(t *testing.T) {
	dataDir := t.TempDir()
	store, err := OpenStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := OpenTokens(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	admin, _, _ := tokens.Create("admin", true)
	ts := httptest.NewServer(New(Options{Store: store, Auth: tokens, Config: Config{MaxBlobBytes: 16}}))
	defer ts.Close()

	content := []byte("hello")
	// bad sha in path
	res := request(t, http.MethodPut, ts.URL+"/v1/blobs/nothex", admin, bytes.NewReader(content), "")
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad sha: %s", res.Status)
	}
	// hash mismatch
	res = request(t, http.MethodPut, ts.URL+"/v1/blobs/"+strings.Repeat("b", 64), admin, bytes.NewReader(content), "")
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("mismatch: %s", res.Status)
	}
	// nothing stored after mismatch
	res = request(t, http.MethodGet, ts.URL+"/v1/blobs/"+strings.Repeat("b", 64), admin, nil, "")
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("mismatched blob stored: %s", res.Status)
	}
	// over limit
	big := bytes.Repeat([]byte("x"), 17)
	res = request(t, http.MethodPut, ts.URL+"/v1/blobs/"+shaOf(big), admin, bytes.NewReader(big), "")
	res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("too large: %s", res.Status)
	}
	// missing Content-Length (chunked)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/v1/blobs/"+shaOf(content), io.NopCloser(bytes.NewReader(content)))
	req.ContentLength = -1
	req.Header.Set("Authorization", "Bearer "+admin)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusLengthRequired {
		t.Fatalf("no length: %s", res.Status)
	}
	// within limit works
	putBlob(t, ts, admin, content)

	// check limit
	many := make([]string, maxBlobCheck+1)
	for i := range many {
		many[i] = shaOf([]byte{byte(i), byte(i >> 8)})
	}
	body, _ := json.Marshal(map[string][]string{"shas": many})
	res = request(t, http.MethodPost, ts.URL+"/v1/blobs/check", admin, bytes.NewReader(body), "application/json")
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("check limit: %s", res.Status)
	}
}
