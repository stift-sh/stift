package agents

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeAgentsConfig(t *testing.T, content string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agents.json")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("STIFT_AGENTS", path)
}

func TestLoadCustomValidation(t *testing.T) {
	writeAgentsConfig(t, `[
		{"name": "roo", "sessions": "~/.roo/tasks/*"},
		{"name": "BadName", "sessions": "~/.x/*"},
		{"name": "claude", "sessions": "~/.x/*"},
		{"name": "roo", "sessions": "~/.other/*"},
		{"name": "nopattern"},
		{"name": "abs", "sessions": "/etc/x/*"}
	]`)
	detectors, warnings := LoadCustom()
	if len(detectors) != 1 || detectors[0].Name() != "roo" {
		t.Fatalf("detectors = %+v, want only roo", detectors)
	}
	if len(warnings) != 5 {
		t.Fatalf("got %d warnings, want 5: %v", len(warnings), warnings)
	}
	for i, must := range []string{"BadName", "built-in", "duplicate", "required", "project-relative"} {
		if !strings.Contains(warnings[i], must) {
			t.Errorf("warning %d = %q, want it to mention %q", i, warnings[i], must)
		}
	}
}

func TestLoadCustomMissingFileIsFine(t *testing.T) {
	t.Setenv("STIFT_AGENTS", filepath.Join(t.TempDir(), "does-not-exist.json"))
	detectors, warnings := LoadCustom()
	if len(detectors) != 0 || len(warnings) != 0 {
		t.Fatalf("got %v / %v, want nothing", detectors, warnings)
	}
}

func TestCustomFileSessions(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".myagent", "sessions", "task-1.json"), `{}`)
	write(t, filepath.Join(home, ".myagent", "sessions", "task-2.json"), `{}`)
	c := Custom{AgentName: "myagent", Sessions: "~/.myagent/sessions/*.json"}

	got, err := c.Detect(home, "")
	if err != nil || len(got) != 2 {
		t.Fatalf("got %d sessions (err %v), want 2", len(got), err)
	}
	ids := map[string]bool{}
	for _, s := range got {
		ids[s.SessionID] = true
		if s.Agent != "myagent" || s.Base != "home" || s.Project != "" || len(s.Files) != 1 {
			t.Errorf("unexpected session: %+v", s)
		}
	}
	if !ids["task-1"] || !ids["task-2"] {
		t.Errorf("ids = %v, want task-1 and task-2", ids)
	}

	// No placeholder: machine-global, so a project filter still finds them.
	got, err = c.Detect(home, "/work/app")
	if err != nil || len(got) != 2 {
		t.Fatalf("project-filtered detect of global agent: %d sessions (err %v), want 2", len(got), err)
	}
}

func TestCustomDirSessions(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".myagent", "tasks", "t1", "log.json"), `{}`)
	write(t, filepath.Join(home, ".myagent", "tasks", "t1", "state.json"), `{}`)
	c := Custom{AgentName: "myagent", Sessions: "~/.myagent/tasks/*"}
	got, err := c.Detect(home, "")
	if err != nil || len(got) != 1 {
		t.Fatalf("got %d sessions (err %v), want 1", len(got), err)
	}
	if got[0].SessionID != "t1" || len(got[0].Files) != 2 {
		t.Errorf("unexpected session: %+v", got[0])
	}
}

func TestCustomPlaceholder(t *testing.T) {
	home := t.TempDir()
	proj := "/work/app"
	write(t, filepath.Join(home, ".roo", CursorProjectHash(proj), "tasks", "task-9", "log.json"), `{}`)
	write(t, filepath.Join(home, ".roo", CursorProjectHash("/other"), "tasks", "task-9", "log.json"), `{}`)
	c := Custom{AgentName: "roo", Sessions: "~/.roo/{md5}/tasks/*"}

	filtered, err := c.Detect(home, proj)
	if err != nil || len(filtered) != 1 {
		t.Fatalf("filtered: %d sessions (err %v), want 1", len(filtered), err)
	}
	if filtered[0].Project != proj {
		t.Errorf("filtered project = %q, want %q", filtered[0].Project, proj)
	}

	all, err := c.Detect(home, "")
	if err != nil || len(all) != 2 {
		t.Fatalf("unfiltered: %d sessions (err %v), want 2", len(all), err)
	}
	// Same directory name under two project hashes must not collide, and the
	// id rule must not depend on whether a project filter was applied.
	if all[0].SessionID == all[1].SessionID {
		t.Errorf("colliding session ids: %q", all[0].SessionID)
	}
	want := map[string]bool{filtered[0].SessionID: false}
	for _, s := range all {
		if _, ok := want[s.SessionID]; ok {
			want[s.SessionID] = true
		}
	}
	if !want[filtered[0].SessionID] {
		t.Errorf("filtered id %q not among unfiltered ids %v", filtered[0].SessionID, all)
	}
}

func TestCustomProjectRelative(t *testing.T) {
	home := t.TempDir()
	proj := t.TempDir()
	write(t, filepath.Join(proj, ".myagent", "history.md"), "# hi")
	c := Custom{AgentName: "myagent", Sessions: ".myagent/history.md"}

	got, err := c.Detect(home, proj)
	if err != nil || len(got) != 1 {
		t.Fatalf("got %d sessions (err %v), want 1", len(got), err)
	}
	if got[0].Base != "project" || got[0].BaseDir != proj || got[0].SessionID != "history" {
		t.Errorf("unexpected session: %+v", got[0])
	}
	if none, _ := c.Detect(home, ""); len(none) != 0 {
		t.Errorf("project-relative pattern detected without a project: %+v", none)
	}
}

func TestCustomNeverEscapesHome(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	write(t, filepath.Join(outside, "secret.txt"), "x")
	// A symlink inside home pointing outside: matches resolve under home's
	// path, so Rel stays local — but a pattern with ".." must not escape.
	c := Custom{AgentName: "evil", Sessions: "~/../" + filepath.Base(outside) + "/*"}
	got, err := c.Detect(home, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("pattern escaped home: %+v", got)
	}
}

func TestDetectIncludesCustomAgents(t *testing.T) {
	home := t.TempDir()
	writeAgentsConfig(t, `[{"name": "myagent", "sessions": "~/.myagent/sessions/*.json"}]`)
	write(t, filepath.Join(home, ".myagent", "sessions", "s1.json"), `{}`)

	got, warnings := Detect(nil, home, "")
	if len(warnings) != 0 {
		t.Fatalf("warnings: %v", warnings)
	}
	if len(got) != 1 || got[0].Agent != "myagent" {
		t.Fatalf("sessions = %+v, want one myagent session", got)
	}
	// --agent filtering works for customs too.
	if only, _ := Detect([]string{"myagent"}, home, ""); len(only) != 1 {
		t.Errorf("name-filtered detect: %+v", only)
	}
	if none, _ := Detect([]string{"claude"}, home, ""); len(none) != 0 {
		t.Errorf("claude filter leaked custom sessions: %+v", none)
	}
	found := false
	for _, n := range Names() {
		if n == "myagent" {
			found = true
		}
	}
	if !found {
		t.Errorf("Names() = %v, missing myagent", Names())
	}
}
