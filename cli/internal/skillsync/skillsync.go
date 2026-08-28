// Package skillsync holds the per-unit push/pull logic for agent configuration
// (skills, subagents, commands, CLAUDE.md) shared by `stift push --skills`,
// `stift pull --skills` and the background daemon.
package skillsync

import (
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/stift-sh/stift/internal/agents"
	"github.com/stift-sh/stift/internal/api"
	"github.com/stift-sh/stift/internal/bundle"
	"github.com/stift-sh/stift/internal/client"
)

// Target is one local config root (agent + scope) resolved for the current
// machine. Each of its units is synced as its own bundle.
type Target struct {
	Agent   string
	Scope   string
	Project string            // scope=project only
	Root    agents.ConfigRoot // BaseDir, patterns
}

// Targets resolves the local config roots for the requested agents (comma
// list, "" for all) and scopes. project is "" to skip project scope.
// Org-scope targets mirror the agent's user root under ~/.stift/org/<agent>
// (see OrgDir) and are only produced when "org" is among scopes.
func Targets(agentList, scopes, home, project string) ([]Target, []string) {
	var names []string
	if agentList != "" {
		names = strings.Split(agentList, ",")
	}
	want := map[string]bool{}
	for _, s := range strings.Split(scopes, ",") {
		want[strings.TrimSpace(s)] = true
	}
	roots, agentNames, warnings := agents.DetectConfigByAgent(names, home, project)
	var out []Target
	seenAgent := map[string]bool{}
	for i, r := range roots {
		a := agentNames[i]
		if want["org"] && !seenAgent[a] && r.Scope == "user" {
			seenAgent[a] = true
			out = append(out, Target{
				Agent: a, Scope: "org",
				Root: agents.ConfigRoot{Scope: "org", BaseDir: OrgDir(home, a), Include: r.Include, Exclude: r.Exclude},
			})
		}
		if !want[r.Scope] {
			continue
		}
		t := Target{Agent: a, Scope: r.Scope, Root: r}
		if r.Scope == "project" {
			t.Project = project
		}
		out = append(out, t)
	}
	return out, warnings
}

// OrgDir is where org-scope units are mirrored locally before being
// symlinked into the agent's own config directory.
func OrgDir(home, agent string) string {
	return filepath.Join(home, ".stift", "org", agent)
}

// Key is the server-side identity of one unit of this target.
func (t Target) Key(name string) client.BundleKey {
	return client.BundleKey{Scope: t.Scope, Agent: t.Agent, Project: t.Project, Name: name}
}

// Label is the human-readable form used in output: agent/scope/name (project).
func (t Target) Label(name string) string {
	s := fmt.Sprintf("%s/%s/%s", t.Agent, t.Scope, name)
	if t.Project != "" {
		s += fmt.Sprintf(" (%s)", t.Project)
	}
	return s
}

// Hostname is the host label recorded on pushed bundle versions.
func Hostname() string {
	host, _ := os.Hostname()
	if host == "" {
		host = "unknown"
	}
	return host
}

// Syncer ties a client, the local sync state and the home directory together.
// Warn receives non-fatal notices (skipped symlinks, unlinkable org units).
type Syncer struct {
	Client *client.Client
	State  *bundle.State
	Server string // server URL, keys the state file
	Home   string
	Host   string
	Warn   func(string)
}

// New builds a Syncer for the configured server using the on-disk state file.
func New(c *client.Client, home string, warn func(string)) (*Syncer, error) {
	st, err := bundle.LoadState()
	if err != nil {
		return nil, err
	}
	cfg, _ := client.LoadConfig()
	if warn == nil {
		warn = func(string) {}
	}
	return &Syncer{Client: c, State: st, Server: cfg.Server, Home: home, Host: Hostname(), Warn: warn}, nil
}

// Entry returns the last-synced state of one unit (zero if never synced).
func (s *Syncer) Entry(t Target, name string) bundle.Entry {
	return s.State.Get(s.Server, t.Scope, t.Agent, t.Project, name)
}

// Set records a sync of one unit.
func (s *Syncer) Set(t Target, name string, version int, manifest map[string]string) error {
	return s.State.Set(s.Server, t.Scope, t.Agent, t.Project, name, version, manifest)
}

// Names returns the unit names recorded in state for a target, sorted.
func (s *Syncer) Names(t Target) []string {
	names := s.State.Names(s.Server, t.Scope, t.Agent, t.Project)
	sort.Strings(names)
	return names
}

// Build returns a unit's local manifest and blob map, passing warnings to Warn.
func (s *Syncer) Build(t Target, u agents.Unit) (api.Bundle, map[string]string, error) {
	b, blobs, warns, err := bundle.Build(t.Root, u)
	for _, w := range warns {
		s.Warn(w)
	}
	return b, blobs, err
}

// Unchanged reports whether a local manifest equals what was last synced.
func Unchanged(entry bundle.Entry, local api.Bundle) bool {
	return entry.Version > 0 && bundle.Diff(local, api.Bundle{Files: ManifestFiles(entry.Manifest)}).Empty()
}

// Push uploads one unit's blobs and publishes it as a new version whose
// parent is the last-synced one, then records the sync. The returned error
// wraps client.ErrStale when the server moved on.
func (s *Syncer) Push(t Target, b api.Bundle, blobs map[string]string, force bool) (int, error) {
	entry := s.Entry(t, b.Name)
	b.Agent, b.Project, b.Parent, b.Host = t.Agent, t.Project, entry.Version, s.Host
	if err := UploadBlobs(s.Client, blobs); err != nil {
		return 0, err
	}
	res, err := s.Client.PutBundle(t.Key(b.Name), b, force)
	if err != nil {
		return 0, err
	}
	return res.Version, s.Set(t, b.Name, res.Version, bundle.Manifest(b))
}

// Dir returns the directory a remote unit of this target is applied into.
func (t Target) Dir(name string, files []string) string {
	return agents.UnitDir(t.Root.BaseDir, name, files)
}

func (s *Syncer) fetch(sha string) (io.ReadCloser, error) { return s.Client.GetBlob(sha) }

// Pull applies one remote manifest locally (see bundle.Apply), records the
// resulting on-disk state and links org units into the agent's directory.
// Nothing is recorded with dryRun.
func (s *Syncer) Pull(t Target, remote api.Bundle, force, dryRun bool) (bundle.ApplyResult, error) {
	if !agents.ValidUnitName(remote.Name) {
		return bundle.ApplyResult{}, fmt.Errorf("refusing unsafe unit name")
	}
	entry := s.Entry(t, remote.Name)
	dir := t.Dir(remote.Name, bundle.Paths(remote))
	res, err := bundle.Apply(remote, s.fetch, dir, entry.Manifest, force, dryRun)
	if err != nil || dryRun {
		return res, err
	}
	// Record what is now on disk: remote content for files we wrote or that
	// matched, the old base entry for conflicts we left alone.
	manifest := bundle.Manifest(remote)
	for _, p := range res.Conflicts {
		if sha, ok := entry.Manifest[p]; ok {
			manifest[p] = sha
		} else {
			delete(manifest, p)
		}
	}
	if err := s.Set(t, remote.Name, remote.Version, manifest); err != nil {
		return res, err
	}
	if t.Scope == "org" {
		s.linkOrgUnit(t.Agent, remote.Name, dir, bundle.Paths(remote))
	}
	return res, nil
}

// Remove deletes the local files of a unit that no longer exists on the
// server, keeping locally modified files unless force, and forgets the unit
// once nothing of it is left.
func (s *Syncer) Remove(t Target, name string, force, dryRun bool) (bundle.ApplyResult, error) {
	if !agents.ValidUnitName(name) {
		return bundle.ApplyResult{}, fmt.Errorf("refusing unsafe unit name")
	}
	entry := s.Entry(t, name)
	dir := t.Dir(name, ManifestPaths(entry.Manifest))
	res, err := bundle.Apply(api.Bundle{}, s.fetch, dir, entry.Manifest, force, dryRun)
	if err != nil || dryRun {
		return res, err
	}
	if t.Scope == "org" {
		s.unlinkOrgUnit(t.Agent, name)
	}
	if len(res.Conflicts) == 0 {
		os.Remove(dir) // empty unit dir, if any
		err = s.State.Forget(s.Server, t.Scope, t.Agent, t.Project, name)
	}
	return res, err
}

// UploadBlobs sends the blobs (sha -> local path) the server does not have yet.
func UploadBlobs(c *client.Client, blobs map[string]string) error {
	shas := make([]string, 0, len(blobs))
	for sha := range blobs {
		shas = append(shas, sha)
	}
	sort.Strings(shas)
	missing, err := c.BlobsCheck(shas)
	if err != nil {
		return err
	}
	for _, sha := range missing {
		p, ok := blobs[sha]
		if !ok {
			return fmt.Errorf("server asked for unknown blob %s", sha)
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		info, err := f.Stat()
		if err == nil {
			err = c.PutBlob(sha, f, info.Size())
		}
		f.Close()
		if err != nil {
			return fmt.Errorf("upload %s: %w", p, err)
		}
	}
	return nil
}

// ManifestFiles turns a path -> sha manifest into bundle file entries.
func ManifestFiles(m map[string]string) []api.BundleFile {
	var out []api.BundleFile
	for p, sha := range m {
		out = append(out, api.BundleFile{Path: p, Sha256: sha})
	}
	return out
}

// ManifestPaths returns the sorted paths of a manifest.
func ManifestPaths(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for p := range m {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// UserConfigRoot returns the user-scope config root of an agent, built-in or
// custom, or false when the agent has none.
func UserConfigRoot(home, agent string) (agents.ConfigRoot, bool) {
	var detectors []agents.ConfigDetector
	detectors = append(detectors, agents.AllConfig...)
	custom, _ := agents.LoadCustom()
	for _, d := range custom {
		if c, ok := d.(agents.ConfigDetector); ok {
			detectors = append(detectors, c)
		}
	}
	for _, d := range detectors {
		if d.Name() != agent {
			continue
		}
		for _, r := range d.Config(home, "") {
			if r.Scope == "user" {
				return r, true
			}
		}
	}
	return agents.ConfigRoot{}, false
}

// orgLink returns the symlink an org unit gets in the agent's user config
// directory and its target in the org mirror. dir is where the unit's
// manifest was applied; for file units the single file is linked.
// Top-level units (CLAUDE.md) cannot be linked without clobbering the user's
// own file and yield ok=false.
func (s *Syncer) orgLink(agent, name, dir string, files []string) (link, target string, ok bool) {
	root, found := UserConfigRoot(s.Home, agent)
	if !found || !strings.Contains(name, "/") {
		return "", "", false
	}
	target = dir
	if len(files) == 1 && dir != filepath.Join(OrgDir(s.Home, agent), filepath.FromSlash(name)) {
		target = filepath.Join(dir, files[0]) // file unit
	}
	rel, err := filepath.Rel(OrgDir(s.Home, agent), target)
	if err != nil || !filepath.IsLocal(rel) {
		return "", "", false
	}
	return filepath.Join(root.BaseDir, rel), target, true
}

// linkOrgUnit symlinks one pulled org unit into the agent's user config
// directory (for Claude Code: ~/.claude/skills/<name> -> ~/.stift/org/claude/skills/<name>).
// An existing entry that is not one of our links is left alone with a warning.
func (s *Syncer) linkOrgUnit(agent, name, dir string, files []string) {
	link, target, ok := s.orgLink(agent, name, dir, files)
	if !ok {
		if _, found := UserConfigRoot(s.Home, agent); !found {
			s.Warn(fmt.Sprintf("%s: no user config directory known; org unit left in %s", agent, dir))
		} else {
			s.Warn(fmt.Sprintf("org unit %s is not linked (top-level files are not merged); see %s", name, dir))
		}
		return
	}
	src := OrgDir(s.Home, agent) + string(filepath.Separator)
	if cur, err := os.Readlink(link); err == nil {
		if cur == target {
			return
		}
		if strings.HasPrefix(cur, src) {
			os.Remove(link)
		}
	}
	if _, err := os.Lstat(link); err == nil {
		s.Warn(fmt.Sprintf("%s exists and is not an org link; skipped", link))
		return
	}
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		s.Warn(err.Error())
		return
	}
	if err := os.Symlink(target, link); err != nil {
		s.Warn(fmt.Sprintf("link %s: %v", link, err))
	}
}

// unlinkOrgUnit removes the link(s) we created for an org unit that no
// longer exists on the server.
func (s *Syncer) unlinkOrgUnit(agent, name string) {
	root, ok := UserConfigRoot(s.Home, agent)
	if !ok || !strings.Contains(name, "/") {
		return
	}
	src := OrgDir(s.Home, agent) + string(filepath.Separator)
	parent := filepath.Join(root.BaseDir, filepath.FromSlash(path.Dir(name)))
	for _, cand := range []string{filepath.Join(root.BaseDir, filepath.FromSlash(name)), filepath.Join(parent, path.Base(name)+".md")} {
		if cur, err := os.Readlink(cand); err == nil && strings.HasPrefix(cur, src) {
			os.Remove(cand)
		}
	}
}
