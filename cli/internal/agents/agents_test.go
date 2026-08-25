package agents

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestMungeClaudePath(t *testing.T) {
	for in, want := range map[string]string{
		"/root/Projects/stift": "-root-Projects-stift",
		"/home/u/my_app.v2":    "-home-u-my-app-v2",
	} {
		if got := MungeClaudePath(in); got != want {
			t.Errorf("MungeClaudePath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestClaudeDetect(t *testing.T) {
	home := t.TempDir()
	proj := "/work/app"
	dir := filepath.Join(home, ".claude", "projects", MungeClaudePath(proj))
	write(t, filepath.Join(dir, "11111111-aaaa-bbbb-cccc-000000000001.jsonl"),
		`{"type":"summary","summary":"Fix login bug"}
{"type":"user","cwd":"/work/app","message":{"role":"user","content":"the login page 500s"}}
`)
	write(t, filepath.Join(home, ".claude", "todos", "11111111-aaaa-bbbb-cccc-000000000001-agent.json"), "[]")
	// A session for some other project, to verify filtering.
	write(t, filepath.Join(home, ".claude", "projects", "-other-proj", "22222222-aaaa-bbbb-cccc-000000000002.jsonl"),
		`{"type":"user","cwd":"/other/proj","message":{"role":"user","content":"hello"}}`)

	got, err := claude{}.Detect(home, proj)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d sessions, want 1: %+v", len(got), got)
	}
	s := got[0]
	if s.SessionID != "11111111-aaaa-bbbb-cccc-000000000001" || s.Project != "/work/app" ||
		s.Title != "Fix login bug" || s.Base != "home" || len(s.Files) != 2 {
		t.Errorf("unexpected session: %+v", s)
	}

	all, err := claude{}.Detect(home, "")
	if err != nil || len(all) != 2 {
		t.Fatalf("unfiltered detect: %d sessions (err %v), want 2", len(all), err)
	}
}

func TestCodexDetect(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".codex", "sessions", "2026", "06", "10",
		"rollout-2026-06-10T09-00-00-99999999-aaaa-bbbb-cccc-000000000009.jsonl"),
		`{"timestamp":"2026-06-10T09:00:00Z","type":"session_meta","payload":{"id":"99999999-aaaa-bbbb-cccc-000000000009","cwd":"/work/app"}}
{"timestamp":"2026-06-10T09:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"add rate limiting"}}
`)
	got, err := codex{}.Detect(home, "/work/app")
	if err != nil || len(got) != 1 {
		t.Fatalf("got %d sessions (err %v), want 1", len(got), err)
	}
	s := got[0]
	if s.SessionID != "99999999-aaaa-bbbb-cccc-000000000009" || s.Title != "add rate limiting" || s.Project != "/work/app" {
		t.Errorf("unexpected session: %+v", s)
	}
	if other, _ := (codex{}).Detect(home, "/elsewhere"); len(other) != 0 {
		t.Errorf("project filter leaked: %+v", other)
	}
}

func TestGeminiDetect(t *testing.T) {
	home := t.TempDir()
	proj := "/work/app"
	dir := filepath.Join(home, ".gemini", "tmp", GeminiProjectHash(proj))
	write(t, filepath.Join(dir, "logs.json"),
		`[{"sessionId":"s1","type":"user","message":"refactor the parser"}]`)
	write(t, filepath.Join(dir, "chats", "saved.json"), `{}`)

	got, err := gemini{}.Detect(home, proj)
	if err != nil || len(got) != 1 {
		t.Fatalf("got %d sessions (err %v), want 1", len(got), err)
	}
	s := got[0]
	if s.Title != "refactor the parser" || s.Project != proj || len(s.Files) != 2 {
		t.Errorf("unexpected session: %+v", s)
	}
}

func TestCursorDetect(t *testing.T) {
	home := t.TempDir()
	proj := "/work/app"
	write(t, filepath.Join(home, ".cursor", "chats", CursorProjectHash(proj),
		"33333333-aaaa-bbbb-cccc-000000000003", "store.db"), "sqlite-bytes")
	got, err := cursor{}.Detect(home, proj)
	if err != nil || len(got) != 1 {
		t.Fatalf("got %d sessions (err %v), want 1", len(got), err)
	}
	if got[0].SessionID != "33333333-aaaa-bbbb-cccc-000000000003" {
		t.Errorf("unexpected session: %+v", got[0])
	}
}

func TestOpencodeDetect(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_DATA_HOME", "") // force the default ~/.local/share location
	storage := filepath.Join(home, ".local", "share", "opencode", "storage")
	write(t, filepath.Join(storage, "session", "proj", "ses_42.json"),
		`{"id":"ses_42","title":"wire up CI","directory":"/work/app","time":{"created":1700000000000,"updated":1700000100000}}`)
	write(t, filepath.Join(storage, "message", "ses_42", "msg_1.json"), `{}`)
	write(t, filepath.Join(storage, "part", "msg_1", "prt_1.json"), `{}`)

	got, err := opencode{}.Detect(home, "/work/app")
	if err != nil || len(got) != 1 {
		t.Fatalf("got %d sessions (err %v), want 1", len(got), err)
	}
	s := got[0]
	if s.SessionID != "ses_42" || s.Title != "wire up CI" || len(s.Files) != 3 {
		t.Errorf("unexpected session: %+v", s)
	}
	if other, _ := (opencode{}).Detect(home, "/elsewhere"); len(other) != 0 {
		t.Errorf("project filter leaked: %+v", other)
	}
}

func TestAiderDetect(t *testing.T) {
	home := t.TempDir()
	proj := t.TempDir()
	write(t, filepath.Join(proj, ".aider.chat.history.md"), "# chat")
	got, err := aider{}.Detect(home, proj)
	if err != nil || len(got) != 1 {
		t.Fatalf("got %d sessions (err %v), want 1", len(got), err)
	}
	if got[0].Base != "project" || got[0].BaseDir != proj {
		t.Errorf("unexpected session: %+v", got[0])
	}
	if none, _ := (aider{}).Detect(home, ""); len(none) != 0 {
		t.Errorf("aider detected sessions without a project: %+v", none)
	}
}

func TestSessionKey(t *testing.T) {
	s := LocalSession{Agent: "claude", SessionID: "abc", Project: "/p"}
	if got := s.Key("host1"); got != "claude|host1|/p|abc" {
		t.Errorf("Key = %q", got)
	}
	s.Project = ""
	if got := s.Key("host1"); got != "claude|host1|-|abc" {
		t.Errorf("Key (no project) = %q", got)
	}
}
