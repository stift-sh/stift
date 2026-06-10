package server

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"stift/internal/api"
)

func newTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dataDir := t.TempDir()
	store, err := OpenStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := OpenTokens(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	admin, _, err := tokens.Create("admin", true)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(New(store, tokens, Config{}))
	t.Cleanup(ts.Close)
	return ts, admin
}

func request(t *testing.T, method, url, token string, body io.Reader, contentType string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func pushSession(t *testing.T, ts *httptest.Server, token string, meta api.Session, payload []byte) api.PushResult {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	metaJSON, _ := json.Marshal(meta)
	fw, _ := mw.CreateFormField("meta")
	fw.Write(metaJSON)
	fw, _ = mw.CreateFormFile("archive", "session.tar.gz")
	fw.Write(payload)
	mw.Close()

	res := request(t, http.MethodPost, ts.URL+"/v1/sessions", token, &buf, mw.FormDataContentType())
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("push: %s: %s", res.Status, b)
	}
	var out api.PushResult
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func testMeta() api.Session {
	return api.Session{
		Key: "claude|host1|/p|abc", Agent: "claude", SessionID: "abc",
		Project: "/p", Host: "host1", Title: "fix the build", Base: "home", Files: 2,
	}
}

func TestAuthRequired(t *testing.T) {
	ts, _ := newTestServer(t)
	for _, tok := range []string{"", "stf_wrong"} {
		res := request(t, http.MethodGet, ts.URL+"/v1/sessions", tok, nil, "")
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("token %q: got %d, want 401", tok, res.StatusCode)
		}
	}
	// healthz and the web UI stay public
	for _, path := range []string{"/healthz", "/"} {
		res := request(t, http.MethodGet, ts.URL+path, "", nil, "")
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Errorf("%s: got %d, want 200", path, res.StatusCode)
		}
	}
}

func TestPushListDownloadDelete(t *testing.T) {
	ts, admin := newTestServer(t)
	payload := []byte("fake-tar-gz-bytes")

	r1 := pushSession(t, ts, admin, testMeta(), payload)
	if r1.Status != "created" {
		t.Fatalf("first push status = %q, want created", r1.Status)
	}
	// Same key + same content: unchanged.
	if r2 := pushSession(t, ts, admin, testMeta(), payload); r2.Status != "unchanged" || r2.Session.ID != r1.Session.ID {
		t.Fatalf("identical re-push: %+v", r2)
	}
	// Same key + new content: updated in place.
	if r3 := pushSession(t, ts, admin, testMeta(), append(payload, '!')); r3.Status != "updated" || r3.Session.ID != r1.Session.ID {
		t.Fatalf("changed re-push: %+v", r3)
	}
	// Different key: a second record.
	other := testMeta()
	other.Key, other.SessionID, other.Agent = "codex|host1|/p|zzz", "zzz", "codex"
	pushSession(t, ts, admin, other, payload)

	res := request(t, http.MethodGet, ts.URL+"/v1/sessions?agent=claude", admin, nil, "")
	var list []api.Session
	json.NewDecoder(res.Body).Decode(&list)
	res.Body.Close()
	if len(list) != 1 || list[0].Agent != "claude" {
		t.Fatalf("filtered list = %+v, want 1 claude session", list)
	}

	res = request(t, http.MethodGet, ts.URL+"/v1/sessions/"+r1.Session.ID+"/archive", admin, nil, "")
	got, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !bytes.Equal(got, append(payload, '!')) {
		t.Fatalf("downloaded %q, want latest payload", got)
	}

	// Prefix resolution.
	res = request(t, http.MethodGet, ts.URL+"/v1/sessions/"+r1.Session.ID[:6], admin, nil, "")
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("prefix get: %s", res.Status)
	}

	res = request(t, http.MethodDelete, ts.URL+"/v1/sessions/"+r1.Session.ID, admin, nil, "")
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %s", res.Status)
	}
	res = request(t, http.MethodGet, ts.URL+"/v1/sessions/"+r1.Session.ID, admin, nil, "")
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("get after delete: %s", res.Status)
	}
}

func TestStoreSurvivesRestart(t *testing.T) {
	dataDir := t.TempDir()
	store, _ := OpenStore(dataDir)
	meta := testMeta()
	saved, _, err := store.Put(meta, bytes.NewReader([]byte("payload")))
	if err != nil {
		t.Fatal(err)
	}

	store2, err := OpenStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := store2.Get(saved.ID)
	if !ok || got.Key != meta.Key || got.Title != meta.Title {
		t.Fatalf("after reopen: ok=%v got=%+v", ok, got)
	}
}

func TestTokenLifecycleAndAdminGate(t *testing.T) {
	ts, admin := newTestServer(t)

	body, _ := json.Marshal(map[string]any{"name": "laptop"})
	res := request(t, http.MethodPost, ts.URL+"/v1/tokens", admin, bytes.NewReader(body), "application/json")
	var created api.TokenCreated
	json.NewDecoder(res.Body).Decode(&created)
	res.Body.Close()
	if created.Token == "" || created.Admin {
		t.Fatalf("created = %+v, want non-admin with secret", created)
	}

	// Non-admin token can push but not mint tokens.
	pushSession(t, ts, created.Token, testMeta(), []byte("x"))
	res = request(t, http.MethodPost, ts.URL+"/v1/tokens", created.Token, bytes.NewReader(body), "application/json")
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin token create: got %d, want 403", res.StatusCode)
	}

	res = request(t, http.MethodDelete, ts.URL+"/v1/tokens/"+created.ID, admin, nil, "")
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: %s", res.Status)
	}
	res = request(t, http.MethodGet, ts.URL+"/v1/sessions", created.Token, nil, "")
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked token still works: %d", res.StatusCode)
	}
}

func TestUploadSizeLimit(t *testing.T) {
	dataDir := t.TempDir()
	store, _ := OpenStore(dataDir)
	tokens, _ := OpenTokens(dataDir)
	admin, _, _ := tokens.Create("admin", true)
	ts := httptest.NewServer(New(store, tokens, Config{MaxUploadBytes: 1024}))
	defer ts.Close()

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	metaJSON, _ := json.Marshal(testMeta())
	fw, _ := mw.CreateFormField("meta")
	fw.Write(metaJSON)
	fw, _ = mw.CreateFormFile("archive", "session.tar.gz")
	fw.Write(bytes.Repeat([]byte("A"), 64*1024))
	mw.Close()

	res := request(t, http.MethodPost, ts.URL+"/v1/sessions", admin, &buf, mw.FormDataContentType())
	res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized upload: got %d, want 413", res.StatusCode)
	}
	if n := len(store.List(ListFilter{})); n != 0 {
		t.Fatalf("oversized upload was stored (%d sessions)", n)
	}
}

func TestPushValidation(t *testing.T) {
	ts, admin := newTestServer(t)
	bad := testMeta()
	bad.Base = "everywhere"
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	metaJSON, _ := json.Marshal(bad)
	fw, _ := mw.CreateFormField("meta")
	fw.Write(metaJSON)
	fw, _ = mw.CreateFormFile("archive", "a.tar.gz")
	fw.Write([]byte("x"))
	mw.Close()
	res := request(t, http.MethodPost, ts.URL+"/v1/sessions", admin, &buf, mw.FormDataContentType())
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("bad base accepted: %s %s", res.Status, b)
	}
}
