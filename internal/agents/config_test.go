package agents

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeConfigRoots(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".claude", "skills", "a", "SKILL.md"), "x")
	roots, warnings := DetectConfig([]string{"claude"}, home, "/work/app")
	if len(warnings) != 0 {
		t.Fatalf("warnings: %v", warnings)
	}
	if len(roots) != 2 || roots[0].Scope != "user" || roots[1].Scope != "project" {
		t.Fatalf("got %+v", roots)
	}
	if roots[0].BaseDir != filepath.Join(home, ".claude") || roots[1].BaseDir != "/work/app" {
		t.Fatalf("bad base dirs: %+v", roots)
	}
	if len(roots[0].Exclude) < len(DefaultExcludes) {
		t.Fatalf("default excludes missing: %v", roots[0].Exclude)
	}
	// No project => user only.
	if roots, _ := DetectConfig([]string{"claude"}, home, ""); len(roots) != 1 {
		t.Fatalf("want 1 root without project, got %d", len(roots))
	}
	// Unknown agent warns.
	if _, w := DetectConfig([]string{"nope"}, home, ""); len(w) != 1 {
		t.Fatalf("want warning for unknown agent, got %v", w)
	}
}

func TestMatchGlob(t *testing.T) {
	cases := []struct {
		pat, p string
		want   bool
	}{
		{"skills/**", "skills/a/SKILL.md", true},
		{"skills/**", "skills", true},
		{"skills/**", "agents/x.md", false},
		{"CLAUDE.md", "CLAUDE.md", true},
		{"CLAUDE.md", "x/CLAUDE.md", false},
		{"**/*.md", "a/b/c.md", true},
		{"**/*.md", "c.md", true},
		{".claude/*.md", ".claude/CLAUDE.md", true},
		{".claude/*.md", ".claude/x/y.md", false},
	}
	for _, c := range cases {
		if got := MatchGlob(c.pat, c.p); got != c.want {
			t.Errorf("MatchGlob(%q,%q)=%v want %v", c.pat, c.p, got, c.want)
		}
	}
	if GlobPrefix("skills/**") != "skills" || GlobPrefix("CLAUDE.md") != "CLAUDE.md" || GlobPrefix("**/x") != "" {
		t.Fatal("GlobPrefix")
	}
}

func TestCustomConfig(t *testing.T) {
	writeAgentsConfig(t, `[{"name":"my","sessions":"~/.my/s/*","config":{"user":["~/.my/skills/**"],"project":[".my/**"]}}]`)
	ds, warnings := LoadCustom()
	if len(ds) != 1 || len(warnings) != 0 {
		t.Fatalf("%v %v", ds, warnings)
	}
	roots := ds[0].(ConfigDetector).Config("/home/u", "/work")
	if len(roots) != 2 || len(roots[0].Include) != 1 || roots[0].Include[0] != ".my/skills/**" || roots[0].BaseDir != "/home/u" {
		t.Fatalf("got %+v", roots)
	}
	if roots[1].BaseDir != "/work" || roots[1].Include[0] != ".my/**" {
		t.Fatalf("got %+v", roots[1])
	}
	// Absolute user patterns are rejected at load time.
	writeAgentsConfig(t, `[{"name":"my","sessions":"~/.my/s/*","config":{"user":["/abs/**"]}}]`)
	if ds, w := LoadCustom(); len(ds) != 0 || len(w) != 1 {
		t.Fatalf("want rejection, got %v %v", ds, w)
	}
}

func TestUnits(t *testing.T) {
	home := t.TempDir()
	base := filepath.Join(home, ".claude")
	write(t, filepath.Join(base, "skills", "deploy", "SKILL.md"), "x")
	write(t, filepath.Join(base, "skills", "review", "SKILL.md"), "x")
	write(t, filepath.Join(base, "skills", ".DS_Store"), "x")
	write(t, filepath.Join(base, "skills", "README.txt"), "x") // loose non-md file: not a unit
	write(t, filepath.Join(base, "agents", "reviewer.md"), "x")
	write(t, filepath.Join(base, "commands", "fix-tests.md"), "x")
	write(t, filepath.Join(base, "commands", "group", "a.md"), "x")
	write(t, filepath.Join(base, "CLAUDE.md"), "x")
	write(t, filepath.Join(base, "settings.json"), "x")
	os.MkdirAll(filepath.Join(home, ".stift", "org", "claude", "skills", "shared"), 0o755)
	os.Symlink(filepath.Join(home, ".stift", "org", "claude", "skills", "shared"), filepath.Join(base, "skills", "shared"))
	os.Symlink(filepath.Join(base, "CLAUDE.md"), filepath.Join(base, "skills", "stray"))

	roots, _ := DetectConfig([]string{"claude"}, home, "")
	units, warnings := roots[0].Units()
	var got []string
	for _, u := range units {
		got = append(got, u.Name)
	}
	want := "CLAUDE.md,agents/reviewer,commands/fix-tests,commands/group,skills/deploy,skills/review"
	if strings.Join(got, ",") != want {
		t.Fatalf("units = %v", got)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "stray") {
		t.Fatalf("warnings = %v", warnings)
	}
	byName := map[string]Unit{}
	for _, u := range units {
		byName[u.Name] = u
	}
	if u := byName["commands/fix-tests"]; !u.IsFile || u.Path != filepath.Join(base, "commands", "fix-tests.md") || u.Rel(roots[0]) != "commands/fix-tests.md" {
		t.Fatalf("file unit = %+v", u)
	}
	if u := byName["CLAUDE.md"]; !u.IsFile || u.Path != filepath.Join(base, "CLAUDE.md") {
		t.Fatalf("CLAUDE.md unit = %+v", u)
	}
	if u := byName["skills/deploy"]; u.IsFile || u.Path != filepath.Join(base, "skills", "deploy") {
		t.Fatalf("dir unit = %+v", u)
	}
	if u := byName["commands/group"]; u.IsFile {
		t.Fatalf("dir under commands = %+v", u)
	}

	// Project scope: names are project-relative, so the two CLAUDE.md files
	// are distinct units.
	proj := t.TempDir()
	write(t, filepath.Join(proj, "CLAUDE.md"), "x")
	write(t, filepath.Join(proj, ".claude", "CLAUDE.md"), "x")
	write(t, filepath.Join(proj, ".claude", "skills", "s", "SKILL.md"), "x")
	roots, _ = DetectConfig([]string{"claude"}, home, proj)
	units, _ = roots[1].Units()
	got = nil
	for _, u := range units {
		got = append(got, u.Name)
	}
	if strings.Join(got, ",") != ".claude/CLAUDE.md,.claude/skills/s,CLAUDE.md" {
		t.Fatalf("project units = %v", got)
	}

	// Empty root: no units, no error.
	if units, _ := (ConfigRoot{BaseDir: t.TempDir(), Include: []string{"skills/**", "CLAUDE.md"}}).Units(); len(units) != 0 {
		t.Fatalf("empty root units = %+v", units)
	}
}

func TestCustomUnits(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".my", "skills", "a", "x.txt"), "x")
	write(t, filepath.Join(home, ".my", "skills", "b.md"), "x")
	write(t, filepath.Join(home, ".my", "rules.md"), "x")
	write(t, filepath.Join(home, ".my", "prompts", "p1.txt"), "x")
	write(t, filepath.Join(home, ".my", "prompts", "p2.txt"), "x")
	write(t, filepath.Join(home, ".my", "prompts", "deep", "p3.txt"), "x")
	writeAgentsConfig(t, `[{"name":"my","sessions":"~/.my/s/*","config":{"user":["~/.my/skills/**","~/.my/rules.md","~/.my/prompts/*.txt"]}}]`)
	roots, warnings := DetectConfig([]string{"my"}, home, "")
	if len(roots) != 1 || len(warnings) != 0 {
		t.Fatalf("%+v %v", roots, warnings)
	}
	units, _ := roots[0].Units()
	var got []string
	for _, u := range units {
		got = append(got, u.Name)
	}
	if strings.Join(got, ",") != ".my/prompts/p1.txt,.my/prompts/p2.txt,.my/rules.md,.my/skills/a,.my/skills/b" {
		t.Fatalf("custom units = %v", got)
	}
}

func TestUnitNames(t *testing.T) {
	for _, ok := range []string{"CLAUDE.md", "skills/a", ".claude/skills/a", "commands/fix-tests"} {
		if !ValidUnitName(ok) {
			t.Errorf("%q rejected", ok)
		}
	}
	for _, bad := range []string{"", "/a", "../a", "a/../b", "a/./b", "a//b", "a/", "a/b/c/d", `a\b`, "C:/x"} {
		if ValidUnitName(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
	if UnitDir("/r", "skills/a", []string{"SKILL.md"}) != filepath.Join("/r", "skills", "a") {
		t.Error("dir unit")
	}
	if UnitDir("/r", "commands/fix", []string{"fix.md"}) != filepath.Join("/r", "commands") {
		t.Error("md file unit")
	}
	if UnitDir("/r", "CLAUDE.md", []string{"CLAUDE.md"}) != "/r" {
		t.Error("top-level file unit")
	}
	if UnitDir("/r", "skills/a", []string{"a.md", "b.md"}) != filepath.Join("/r", "skills", "a") {
		t.Error("multi-file dir unit")
	}
}
