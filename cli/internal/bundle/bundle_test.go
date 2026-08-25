package bundle

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stift-sh/stift/engine/api"
	"github.com/stift-sh/stift/internal/agents"
)

func write(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
}

func claudeRoot(t *testing.T) (string, agents.ConfigRoot) {
	home := t.TempDir()
	roots, _ := agents.DetectConfig([]string{"claude"}, home, "")
	return home, roots[0]
}

func unitNamed(t *testing.T, root agents.ConfigRoot, name string) agents.Unit {
	t.Helper()
	units, _ := root.Units()
	for _, u := range units {
		if u.Name == name {
			return u
		}
	}
	t.Fatalf("no unit %q in %+v", name, units)
	return agents.Unit{}
}

func TestBuild(t *testing.T) {
	home, root := claudeRoot(t)
	base := filepath.Join(home, ".claude")
	write(t, filepath.Join(base, "skills", "a", "SKILL.md"), "---\nname: a\n---\n", 0o644)
	write(t, filepath.Join(base, "skills", "a", "run.sh"), "#!/bin/sh\n", 0o755)
	write(t, filepath.Join(base, "skills", "a", ".hidden"), "x", 0o644)
	write(t, filepath.Join(base, "skills", "a", "secrets.env"), "x", 0o644)
	write(t, filepath.Join(base, "skills", "a", "settings.local.json"), "{}", 0o644)
	write(t, filepath.Join(base, "skills", "b", "SKILL.md"), "b", 0o644)
	write(t, filepath.Join(base, "commands", "fix.md"), "fix", 0o644)
	write(t, filepath.Join(base, "CLAUDE.md"), "hi", 0o644)
	write(t, filepath.Join(base, "settings.json"), "{}", 0o644)
	write(t, filepath.Join(base, "projects", "x.jsonl"), "{}", 0o644)
	os.Symlink(filepath.Join(base, "CLAUDE.md"), filepath.Join(base, "skills", "a", "link.md"))

	// Directory unit: paths are relative to the unit.
	b, blobs, warnings, err := Build(root, unitNamed(t, root, "skills/a"))
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, f := range b.Files {
		paths = append(paths, f.Path)
	}
	if got := strings.Join(paths, ","); got != "SKILL.md,run.sh" {
		t.Fatalf("paths: %s", got)
	}
	if b.Name != "skills/a" || b.Scope != "user" {
		t.Fatalf("name/scope: %+v", b)
	}
	if b.Files[1].Mode&0o111 == 0 || b.Files[0].Mode&0o111 != 0 {
		t.Fatalf("modes: %+v", b.Files)
	}
	if len(blobs) != 2 || len(warnings) != 1 || !strings.Contains(warnings[0], "symlink") {
		t.Fatalf("blobs=%d warnings=%v", len(blobs), warnings)
	}

	// File units: a single file at the unit root.
	for _, c := range []struct{ name, file, sha string }{
		{"CLAUDE.md", "CLAUDE.md", "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4"},
		{"commands/fix", "fix.md", ""},
	} {
		b, _, _, err := Build(root, unitNamed(t, root, c.name))
		if err != nil {
			t.Fatal(err)
		}
		if len(b.Files) != 1 || b.Files[0].Path != c.file || (c.sha != "" && b.Files[0].SHA256 != c.sha) {
			t.Fatalf("%s: %+v", c.name, b.Files)
		}
	}

	// BuildAll covers every unit, in name order.
	all, blobs, _, err := BuildAll(root)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, b := range all {
		names = append(names, b.Name)
	}
	if got := strings.Join(names, ","); got != "CLAUDE.md,commands/fix,skills/a,skills/b" {
		t.Fatalf("units: %s", got)
	}
	if len(blobs) != 5 {
		t.Fatalf("blobs = %d", len(blobs))
	}
}

func TestDiff(t *testing.T) {
	local := api.Bundle{Files: []api.BundleFile{{Path: "a", SHA256: "1"}, {Path: "b", SHA256: "2"}, {Path: "c", SHA256: "3"}}}
	remote := api.Bundle{Files: []api.BundleFile{{Path: "a", SHA256: "1"}, {Path: "b", SHA256: "x"}, {Path: "d", SHA256: "4"}}}
	ch := Diff(local, remote)
	if strings.Join(ch.Added, ",") != "c" || strings.Join(ch.Modified, ",") != "b" || strings.Join(ch.Removed, ",") != "d" {
		t.Fatalf("%+v", ch)
	}
	if !Diff(local, local).Empty() {
		t.Fatal("self diff not empty")
	}
}

func TestApply(t *testing.T) {
	// Source unit -> bundle -> apply into empty dir -> identical tree.
	home, root := claudeRoot(t)
	base := filepath.Join(home, ".claude")
	write(t, filepath.Join(base, "skills", "a", "SKILL.md"), "v1", 0o644)
	write(t, filepath.Join(base, "skills", "a", "run.sh"), "#!/bin/sh\n", 0o755)
	write(t, filepath.Join(base, "skills", "a", "lib", "x.py"), "rules", 0o644)
	unit := unitNamed(t, root, "skills/a")
	remote, blobs, _, err := Build(root, unit)
	if err != nil {
		t.Fatal(err)
	}
	fetch := func(sha string) (io.ReadCloser, error) {
		data, err := os.ReadFile(blobs[sha])
		return io.NopCloser(bytes.NewReader(data)), err
	}

	dstRoot := t.TempDir()
	dst := agents.UnitDir(dstRoot, remote.Name, Paths(remote))
	if dst != filepath.Join(dstRoot, "skills", "a") {
		t.Fatalf("unit dir = %s", dst)
	}
	res, err := Apply(remote, fetch, dst, nil, false, true)
	if err != nil || len(res.Written) != 3 {
		t.Fatalf("dry run: %+v %v", res, err)
	}
	if _, err := os.Stat(filepath.Join(dst, "SKILL.md")); err == nil {
		t.Fatal("dry run wrote files")
	}
	res, err = Apply(remote, fetch, dst, nil, false, false)
	if err != nil || len(res.Written) != 3 {
		t.Fatalf("apply: %+v %v", res, err)
	}
	if data, _ := os.ReadFile(filepath.Join(dst, "SKILL.md")); string(data) != "v1" {
		t.Fatalf("content: %q", data)
	}
	if info, _ := os.Stat(filepath.Join(dst, "run.sh")); info.Mode()&0o111 == 0 {
		t.Fatal("exec bit lost")
	}
	// Second apply: unchanged.
	if res, _ = Apply(remote, fetch, dst, Manifest(remote), false, false); res.Unchanged != 3 || len(res.Written) != 0 {
		t.Fatalf("re-apply: %+v", res)
	}

	// Local modification is preserved without force, overwritten with force.
	state := Manifest(remote)
	write(t, filepath.Join(dst, "SKILL.md"), "my edits", 0o644)
	write(t, filepath.Join(base, "skills", "a", "SKILL.md"), "v2", 0o644)
	remote2, blobs2, _, _ := Build(root, unit)
	for k, v := range blobs2 {
		blobs[k] = v
	}
	res, err = Apply(remote2, fetch, dst, state, false, false)
	if err != nil || len(res.Conflicts) != 1 || res.Conflicts[0] != "SKILL.md" {
		t.Fatalf("conflict: %+v %v", res, err)
	}
	if data, _ := os.ReadFile(filepath.Join(dst, "SKILL.md")); string(data) != "my edits" {
		t.Fatal("local edit overwritten")
	}
	res, err = Apply(remote2, fetch, dst, state, true, false)
	if err != nil || len(res.Written) != 1 {
		t.Fatalf("force: %+v %v", res, err)
	}
	if data, _ := os.ReadFile(filepath.Join(dst, "SKILL.md")); string(data) != "v2" {
		t.Fatal("force did not overwrite")
	}

	// Remote removal deletes an unmodified file (and empty parents) but
	// keeps a modified one.
	state = Manifest(remote2)
	os.Remove(filepath.Join(base, "skills", "a", "lib", "x.py"))
	os.Remove(filepath.Join(base, "skills", "a", "run.sh"))
	remote3, _, _, _ := Build(root, unit)
	write(t, filepath.Join(dst, "run.sh"), "edited", 0o755)
	res, err = Apply(remote3, fetch, dst, state, false, false)
	if err != nil || len(res.Deleted) != 1 || res.Deleted[0] != "lib/x.py" || len(res.Conflicts) != 1 {
		t.Fatalf("removal: %+v %v", res, err)
	}
	if _, err := os.Stat(filepath.Join(dst, "lib")); err == nil {
		t.Fatal("empty lib/ not removed")
	}
	if _, err := os.Stat(filepath.Join(dst, "run.sh")); err != nil {
		t.Fatal("modified file deleted")
	}

	// File units apply into the unit's parent directory.
	write(t, filepath.Join(base, "commands", "fix.md"), "fix", 0o644)
	cmdRemote, cmdBlobs, _, err := Build(root, unitNamed(t, root, "commands/fix"))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range cmdBlobs {
		blobs[k] = v
	}
	cmdDst := agents.UnitDir(dstRoot, cmdRemote.Name, Paths(cmdRemote))
	if cmdDst != filepath.Join(dstRoot, "commands") {
		t.Fatalf("file unit dir = %s", cmdDst)
	}
	if _, err := Apply(cmdRemote, fetch, cmdDst, nil, false, false); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(dstRoot, "commands", "fix.md")); string(data) != "fix" {
		t.Fatalf("file unit content: %q", data)
	}
	if agents.UnitDir(dstRoot, "CLAUDE.md", []string{"CLAUDE.md"}) != dstRoot {
		t.Fatal("CLAUDE.md unit dir")
	}

	// Unsafe paths are refused.
	bad := api.Bundle{Files: []api.BundleFile{{Path: "../x", SHA256: "0"}}}
	if _, err := Apply(bad, fetch, dst, nil, true, false); err == nil {
		t.Fatal("escaping path accepted")
	}
	bad.Files[0].Path = "/etc/x"
	if _, err := Apply(bad, fetch, dst, nil, true, false); err == nil {
		t.Fatal("absolute path accepted")
	}
}

func TestState(t *testing.T) {
	t.Setenv("STIFT_SKILLS_STATE", filepath.Join(t.TempDir(), "state.json"))
	st, err := LoadState()
	if err != nil {
		t.Fatal(err)
	}
	if st.Get("http://s", "user", "claude", "", "skills/a").Version != 0 {
		t.Fatal("expected empty entry")
	}
	if err := st.Set("http://s/", "user", "claude", "", "skills/a", 3, map[string]string{"a": "1"}); err != nil {
		t.Fatal(err)
	}
	if err := st.Set("http://s/", "user", "claude", "", "CLAUDE.md", 1, nil); err != nil {
		t.Fatal(err)
	}
	st, _ = LoadState()
	if e := st.Get("http://s", "user", "claude", "", "skills/a"); e.Version != 3 || e.Manifest["a"] != "1" {
		t.Fatalf("%+v", e)
	}
	if st.Get("http://s", "user", "claude", "", "CLAUDE.md").Version != 1 {
		t.Fatal("units share state")
	}
	if n := st.Names("http://s", "user", "claude", ""); len(n) != 2 {
		t.Fatalf("names = %v", n)
	}
	if err := st.Forget("http://s", "user", "claude", "", "CLAUDE.md"); err != nil {
		t.Fatal(err)
	}
	if n := st.Names("http://s", "user", "claude", ""); len(n) != 1 || n[0] != "skills/a" {
		t.Fatalf("names after forget = %v", n)
	}
}
