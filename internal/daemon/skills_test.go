package daemon

import (
	"bytes"
	"log"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stift-sh/stift/engine/server"
	"github.com/stift-sh/stift/internal/bundle"
	"github.com/stift-sh/stift/internal/client"
)

func TestDebouncer(t *testing.T) {
	t0 := time.Unix(1000, 0)
	d := newDebouncer(time.Minute)
	if d.Observe("u", "a", t0) {
		t.Fatal("first observation must not settle")
	}
	if d.Observe("u", "a", t0.Add(30*time.Second)) {
		t.Fatal("settled before window")
	}
	if !d.Observe("u", "a", t0.Add(time.Minute)) {
		t.Fatal("should settle at window")
	}
	// A change restarts the window.
	if d.Observe("u", "b", t0.Add(2*time.Minute)) || d.Observe("u", "b", t0.Add(2*time.Minute+59*time.Second)) {
		t.Fatal("changed hash must restart the window")
	}
	if !d.Observe("u", "b", t0.Add(3*time.Minute)) {
		t.Fatal("should settle after restart")
	}
	d.Forget("u")
	if d.Observe("u", "b", t0.Add(3*time.Minute)) {
		t.Fatal("forgotten unit starts over")
	}
	if !newDebouncer(0).Observe("x", "h", t0) {
		t.Fatal("zero window settles immediately")
	}
}

func TestDecidePull(t *testing.T) {
	synced := bundle.Entry{Version: 2}
	cases := []struct {
		name          string
		scope         string
		entry         bundle.Entry
		remote        int
		exists, modif bool
		want          pullAction
	}{
		{"not newer", "user", synced, 2, true, false, pullSkip},
		{"older", "user", synced, 1, true, true, pullSkip},
		{"newer unmodified", "user", synced, 3, true, false, pullApply},
		{"newer modified", "user", synced, 3, true, true, pullConflict},
		{"newer gone locally", "user", synced, 3, false, false, pullApply},
		{"never synced, absent", "user", bundle.Entry{}, 1, false, false, pullApply},
		{"never synced, present", "user", bundle.Entry{}, 1, true, false, pullConflict},
		{"org modified", "org", synced, 3, true, true, pullApply},
		{"org not newer", "org", synced, 2, true, true, pullSkip},
	}
	for _, c := range cases {
		if got := decidePull(c.scope, c.entry, c.remote, c.exists, c.modif); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestManifestHash(t *testing.T) {
	a := manifestHash(map[string]string{"x": "1", "y": "2"})
	b := manifestHash(map[string]string{"y": "2", "x": "1"})
	if a != b || a == manifestHash(map[string]string{"x": "1"}) || manifestHash(nil) != "" {
		t.Fatal("manifestHash is not a stable content digest")
	}
}

// newSkillsServer runs the real HTTP server on a DiskStore and returns a client.
func newSkillsServer(t *testing.T) (*httptest.Server, *client.Client) {
	t.Helper()
	dataDir := t.TempDir()
	store, err := server.OpenStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := server.OpenTokens(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	tok, _, err := tokens.Create("admin", true)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.New(server.Options{Store: store, Auth: tokens, Tokens: tokens}))
	t.Cleanup(ts.Close)
	t.Setenv("STIFT_SERVER", ts.URL)
	t.Setenv("STIFT_TOKEN", tok)
	t.Setenv("STIFT_AGENTS", filepath.Join(dataDir, "no-agents.json"))
	return ts, client.New(ts.URL, tok)
}

// newSkillsDaemon builds a daemon with its own home and state files.
func newSkillsDaemon(t *testing.T, c *client.Client, host string, window time.Duration) (*Daemon, string, *bytes.Buffer) {
	t.Helper()
	home := t.TempDir()
	var buf bytes.Buffer
	d := &Daemon{client: c, home: home, host: host, state: &State{path: filepath.Join(home, "sync.json"), Pushed: map[string]string{}, Restored: map[string]bool{}},
		skills: newSkillsSync(window), log: log.New(&buf, "", 0)}
	return d, home, &buf
}

// withSkillsState points the skills state file at home for the duration of fn.
func withSkillsState(t *testing.T, home string, fn func()) {
	t.Helper()
	t.Setenv("STIFT_SKILLS_STATE", filepath.Join(home, "skills-state.json"))
	fn()
}

func writeSkill(t *testing.T, home, name, body string) string {
	t.Helper()
	dir := filepath.Join(home, ".claude", "skills", name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "SKILL.md")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSkillsPassPushAndPull(t *testing.T) {
	_, c := newSkillsServer(t)
	a, homeA, logA := newSkillsDaemon(t, c, "alpha", 50*time.Millisecond)
	writeSkill(t, homeA, "deploy", "---\nname: deploy\n---\nship it\n")

	withSkillsState(t, homeA, func() {
		a.skillsPass(nil) // first observation: debounced
		if strings.Contains(logA.String(), "pushed") {
			t.Fatalf("pushed before debounce window:\n%s", logA.String())
		}
		time.Sleep(60 * time.Millisecond)
		a.skillsPass(nil)
	})
	if !strings.Contains(logA.String(), "skills pushed claude/user/skills/deploy v1") {
		t.Fatalf("expected push, log:\n%s", logA.String())
	}

	// A second machine pulls it.
	b, homeB, logB := newSkillsDaemon(t, c, "beta", time.Hour)
	withSkillsState(t, homeB, func() { b.skillsPass(nil) })
	got, err := os.ReadFile(filepath.Join(homeB, ".claude", "skills", "deploy", "SKILL.md"))
	if err != nil || !strings.Contains(string(got), "ship it") {
		t.Fatalf("pull failed (%v), log:\n%s", err, logB.String())
	}
	if !strings.Contains(logB.String(), "skills pulled claude/user/skills/deploy v1") {
		t.Fatalf("expected pull log, got:\n%s", logB.String())
	}

	// B edits locally while A publishes v2: B logs a conflict exactly once and
	// never pushes over the newer server version.
	writeSkill(t, homeB, "deploy", "local edit\n")
	writeSkill(t, homeA, "deploy", "v2\n")
	withSkillsState(t, homeA, func() {
		a.skillsPass(nil)
		time.Sleep(60 * time.Millisecond)
		a.skillsPass(nil)
	})
	if !strings.Contains(logA.String(), "skills pushed claude/user/skills/deploy v2") {
		t.Fatalf("expected v2 push, log:\n%s", logA.String())
	}
	logB.Reset()
	withSkillsState(t, homeB, func() {
		b.skills.deb.window = 0
		b.skillsPass(nil)
		b.skillsPass(nil)
	})
	if n := strings.Count(logB.String(), "skills conflict claude/user/skills/deploy"); n != 1 {
		t.Fatalf("want one conflict line, got %d:\n%s", n, logB.String())
	}
	if n := strings.Count(logB.String(), "skills stale"); n != 1 {
		t.Fatalf("want one stale line, got %d:\n%s", n, logB.String())
	}
	got, _ = os.ReadFile(filepath.Join(homeB, ".claude", "skills", "deploy", "SKILL.md"))
	if string(got) != "local edit\n" {
		t.Fatalf("local edit was overwritten: %q", got)
	}
	heads, err := c.ListBundles(client.BundleFilter{})
	if err != nil || len(heads) != 1 || heads[0].Version != 2 || heads[0].Host != "alpha" {
		t.Fatalf("server head changed unexpectedly: %+v (%v)", heads, err)
	}
}
