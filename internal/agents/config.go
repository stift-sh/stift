package agents

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// ConfigRoot is one directory tree of agent configuration (skills,
// subagents, commands, CLAUDE.md, ...). It is synced as a set of independent
// units (see Units), one bundle each.
//
// Include and Exclude are forward-slash glob patterns relative to BaseDir.
// "*" and "?" match within one path segment, "**" matches any number of
// segments. An Exclude pattern without a "/" is matched against the file
// name alone, so "*.env" excludes env files at any depth.
type ConfigRoot struct {
	Scope   string // user|project
	BaseDir string // absolute directory Include/Exclude are relative to
	Include []string
	Exclude []string
}

// ConfigDetector describes where one agent keeps its configuration.
type ConfigDetector interface {
	Name() string
	// Config returns the file roots to bundle for each scope. project may be
	// "" in which case only user-scope roots are returned.
	Config(home, project string) []ConfigRoot
}

// DefaultExcludes are applied to every ConfigRoot: hook/MCP/settings files
// may hold secrets and are executable, env files hold secrets, dotfiles are
// editor/OS noise. Files over MaxConfigFileSize and symlinks are skipped by
// the bundle builder regardless of patterns.
var DefaultExcludes = []string{
	"settings*.json",
	".mcp.json",
	"*.env",
	".env*",
	".*", // .DS_Store, .gitignore, ...
}

// MaxConfigFileSize is the largest file included in a config bundle.
const MaxConfigFileSize int64 = 5 << 20

// MaxUnitSegments is the deepest a unit name may nest (mirrors the server).
const MaxUnitSegments = 3

// Unit is one independently versioned piece of configuration inside a
// ConfigRoot: a skill directory, a subagent, a single command file, a
// CLAUDE.md. Name is the unit's path relative to the root (see UnitName);
// Path is the absolute directory (or file, when IsFile) on disk.
type Unit struct {
	Name   string
	Path   string
	IsFile bool
}

// Rel returns the unit's on-disk location relative to the config root.
func (u Unit) Rel(root ConfigRoot) string {
	rel, err := filepath.Rel(root.BaseDir, u.Path)
	if err != nil {
		return ""
	}
	return filepath.ToSlash(rel)
}

// UnitName derives a unit name from a root-relative path. Markdown files
// enumerated from a "<dir>/**" pattern (stem=true) drop their ".md" so that
// commands/fix-tests.md becomes "commands/fix-tests"; literal patterns such
// as CLAUDE.md or .claude/CLAUDE.md keep their full name.
func UnitName(rel string, stem bool) string {
	if stem && strings.HasSuffix(rel, ".md") {
		return strings.TrimSuffix(rel, ".md")
	}
	return rel
}

// UnitDir returns the directory a unit's manifest is applied into (or built
// from), given the root and the unit's files. Directory units live at
// <root>/<name>; a file unit is a manifest holding exactly one top-level
// file named after the unit (with or without ".md"), applied into the
// unit's parent directory.
func UnitDir(root, name string, files []string) string {
	if len(files) == 1 && !strings.Contains(files[0], "/") {
		base := path.Base(name)
		if files[0] == base || files[0] == base+".md" {
			return filepath.Join(root, filepath.FromSlash(path.Dir(name)))
		}
	}
	return filepath.Join(root, filepath.FromSlash(name))
}

// ValidUnitName mirrors the server's rule: 1-MaxUnitSegments clean
// forward-slash segments, none empty, "." or "..".
func ValidUnitName(name string) bool {
	if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "\\") || path.Clean(name) != name {
		return false
	}
	segs := strings.Split(name, "/")
	if len(segs) > MaxUnitSegments {
		return false
	}
	for _, seg := range segs {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return !(len(name) >= 2 && name[1] == ':')
}

// Units enumerates the units currently present under the root, sorted by
// name. For each Include pattern:
//
//   - a literal path ("CLAUDE.md", ".claude/CLAUDE.md") is one unit, a file
//     or a directory;
//   - "<dir>/**" yields every entry directly under <dir>: directories are
//     directory units named "<dir>/<entry>", markdown files are file units
//     named "<dir>/<stem>" (commands/fix-tests.md -> commands/fix-tests);
//   - any other glob yields one unit per match, named by its relative path.
//
// Excluded entries, symlinks (org links included) and names deeper than
// MaxUnitSegments are skipped; warnings describe what was skipped.
func (r ConfigRoot) Units() ([]Unit, []string) {
	var warnings []string
	byName := map[string]Unit{}
	add := func(rel string, info os.FileInfo, p string, stem bool) {
		if info.Mode()&os.ModeSymlink != 0 {
			if target, err := os.Readlink(p); err != nil || !strings.Contains(filepath.ToSlash(target), "/.stift/org/") {
				warnings = append(warnings, fmt.Sprintf("skipping symlink %s", p))
			}
			return
		}
		isFile := !info.IsDir()
		if isFile && !info.Mode().IsRegular() {
			return
		}
		name := UnitName(rel, isFile && stem)
		if !ValidUnitName(name) {
			warnings = append(warnings, fmt.Sprintf("skipping %s: unit name %q is not 1-%d clean path segments", p, name, MaxUnitSegments))
			return
		}
		if prev, ok := byName[name]; ok {
			if prev.Path != p {
				warnings = append(warnings, fmt.Sprintf("skipping %s: unit name %q already used by %s", p, name, prev.Path))
			}
			return
		}
		byName[name] = Unit{Name: name, Path: p, IsFile: isFile}
	}
	for _, pat := range r.Include {
		pat = path.Clean(pat)
		prefix := GlobPrefix(pat)
		rest := strings.TrimPrefix(strings.TrimPrefix(pat, prefix), "/")
		start := filepath.Join(r.BaseDir, filepath.FromSlash(prefix))
		switch {
		case rest == "": // literal
			info, err := os.Lstat(start)
			if err != nil {
				continue
			}
			add(prefix, info, start, false)
		case rest == "**":
			entries, err := os.ReadDir(start)
			if err != nil {
				continue
			}
			for _, e := range entries {
				rel := path.Join(prefix, e.Name())
				if Excluded(r.Exclude, rel, e.Name()) {
					continue
				}
				info, err := os.Lstat(filepath.Join(start, e.Name()))
				if err != nil {
					continue
				}
				if !info.IsDir() && info.Mode()&os.ModeSymlink == 0 && !strings.HasSuffix(e.Name(), ".md") {
					continue // loose non-markdown files are not units
				}
				add(rel, info, filepath.Join(start, e.Name()), true)
			}
		default: // other globs: each match is a unit
			filepath.WalkDir(start, func(p string, d os.DirEntry, err error) error {
				if err != nil {
					return nil
				}
				rel, err := filepath.Rel(r.BaseDir, p)
				if err != nil || !filepath.IsLocal(rel) {
					return nil
				}
				rel = filepath.ToSlash(rel)
				if p != start && Excluded(r.Exclude, rel, d.Name()) {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
				if !MatchGlob(pat, rel) {
					return nil
				}
				info, err := os.Lstat(p)
				if err != nil {
					return nil
				}
				add(rel, info, p, false)
				if d.IsDir() {
					return filepath.SkipDir // a matched directory is one unit
				}
				return nil
			})
		}
	}
	units := make([]Unit, 0, len(byName))
	for _, u := range byName {
		units = append(units, u)
	}
	sort.Slice(units, func(i, j int) bool { return units[i].Name < units[j].Name })
	return units, warnings
}

// Excluded reports whether rel (forward-slash, root-relative) with base
// name matches any exclude pattern; patterns without "/" match the name.
func Excluded(patterns []string, rel, name string) bool {
	for _, pat := range patterns {
		if strings.Contains(pat, "/") {
			if MatchGlob(pat, rel) {
				return true
			}
		} else if ok, _ := path.Match(pat, name); ok {
			return true
		}
	}
	return false
}

// AllConfig lists the built-in config detectors.
var AllConfig = []ConfigDetector{claude{}}

// ConfigNames returns the names of every agent that has a config detector,
// built-in and custom alike.
func ConfigNames() []string {
	custom, _ := LoadCustom()
	var n []string
	for _, d := range AllConfig {
		n = append(n, d.Name())
	}
	for _, d := range custom {
		if c, ok := d.(ConfigDetector); ok && len(c.Config("/", "")) > 0 {
			n = append(n, c.Name())
		}
	}
	return n
}

// DetectConfig returns the config roots of the named agents (all agents
// when names is empty). Roots are tagged with the agent name via the
// returned map order: each ConfigRoot belongs to the agent at the same
// index of the returned names slice. Warnings come from custom agent loading.
func DetectConfig(names []string, home, project string) ([]ConfigRoot, []string) {
	roots, _, warnings := DetectConfigByAgent(names, home, project)
	return roots, warnings
}

// DetectConfigByAgent is DetectConfig but also returns, per root, the name
// of the agent it belongs to (agents[i] pairs with roots[i]).
func DetectConfigByAgent(names []string, home, project string) (roots []ConfigRoot, agents []string, warnings []string) {
	want := map[string]bool{}
	for _, n := range names {
		want[strings.ToLower(strings.TrimSpace(n))] = true
	}
	custom, warnings := LoadCustom()
	var detectors []ConfigDetector
	detectors = append(detectors, AllConfig...)
	for _, d := range custom {
		if c, ok := d.(ConfigDetector); ok {
			detectors = append(detectors, c)
		}
	}
	for _, d := range detectors {
		if len(want) > 0 && !want[d.Name()] {
			continue
		}
		for _, r := range d.Config(home, project) {
			r.Exclude = append(append([]string{}, DefaultExcludes...), r.Exclude...)
			roots = append(roots, r)
			agents = append(agents, d.Name())
		}
	}
	for n := range want {
		found := false
		for _, a := range agents {
			if a == n {
				found = true
			}
		}
		if !found {
			warnings = append(warnings, fmt.Sprintf("%s: no config detector for this agent", n))
		}
	}
	return roots, agents, warnings
}

// Config implements ConfigDetector for Claude Code.
func (claude) Config(home, project string) []ConfigRoot {
	roots := []ConfigRoot{{
		Scope:   "user",
		BaseDir: filepath.Join(home, ".claude"),
		Include: []string{"skills/**", "agents/**", "commands/**", "CLAUDE.md"},
	}}
	if project != "" {
		roots = append(roots, ConfigRoot{
			Scope:   "project",
			BaseDir: project,
			Include: []string{".claude/skills/**", ".claude/agents/**", ".claude/commands/**", ".claude/CLAUDE.md", "CLAUDE.md"},
		})
	}
	return roots
}

// MatchGlob reports whether the forward-slash relative path p matches the
// glob pattern (see ConfigRoot for the syntax).
func MatchGlob(pattern, p string) bool {
	return matchSegs(strings.Split(path.Clean(pattern), "/"), strings.Split(p, "/"))
}

func matchSegs(pat, segs []string) bool {
	for len(pat) > 0 {
		if pat[0] == "**" {
			if len(pat) == 1 {
				return true
			}
			for i := 0; i <= len(segs); i++ {
				if matchSegs(pat[1:], segs[i:]) {
					return true
				}
			}
			return false
		}
		if len(segs) == 0 {
			return false
		}
		if ok, _ := path.Match(pat[0], segs[0]); !ok {
			return false
		}
		pat, segs = pat[1:], segs[1:]
	}
	return len(segs) == 0
}

// GlobPrefix returns the literal directory prefix of a pattern (the part
// before the first segment containing a wildcard), used to limit walks.
func GlobPrefix(pattern string) string {
	var out []string
	for _, seg := range strings.Split(path.Clean(pattern), "/") {
		if strings.ContainsAny(seg, "*?[") {
			break
		}
		out = append(out, seg)
	}
	return strings.Join(out, "/")
}
