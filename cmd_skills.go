package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/stift-sh/stift/engine/api"
	"github.com/stift-sh/stift/internal/agents"
	"github.com/stift-sh/stift/internal/bundle"
	"github.com/stift-sh/stift/internal/client"
)

// skillsTarget is one local config root (agent + scope) resolved for the
// current machine. Each of its units is synced as its own bundle.
type skillsTarget struct {
	Agent   string
	Scope   string
	Project string            // scope=project only
	Root    agents.ConfigRoot // BaseDir, patterns
}

// skillsTargets resolves the local config roots for the requested agents and
// scopes. project is "" to skip project scope. Org-scope targets mirror the
// agent's user root under ~/.stift/org/<agent> (see orgDir) and are only
// produced when "org" is among scopes.
func skillsTargets(agentList, scopes string, home, project string) ([]skillsTarget, []string) {
	var names []string
	if agentList != "" {
		names = strings.Split(agentList, ",")
	}
	want := map[string]bool{}
	for _, s := range strings.Split(scopes, ",") {
		want[strings.TrimSpace(s)] = true
	}
	roots, agentNames, warnings := agents.DetectConfigByAgent(names, home, project)
	var out []skillsTarget
	seenAgent := map[string]bool{}
	for i, r := range roots {
		a := agentNames[i]
		if want["org"] && !seenAgent[a] && r.Scope == "user" {
			seenAgent[a] = true
			out = append(out, skillsTarget{
				Agent: a, Scope: "org",
				Root: agents.ConfigRoot{Scope: "org", BaseDir: orgDir(home, a), Include: r.Include, Exclude: r.Exclude},
			})
		}
		if !want[r.Scope] {
			continue
		}
		t := skillsTarget{Agent: a, Scope: r.Scope, Root: r}
		if r.Scope == "project" {
			t.Project = project
		}
		out = append(out, t)
	}
	return out, warnings
}

// orgDir is where org-scope units are mirrored locally before being
// symlinked into the agent's own config directory.
func orgDir(home, agent string) string {
	return filepath.Join(home, ".stift", "org", agent)
}

func (t skillsTarget) key(name string) client.BundleKey {
	return client.BundleKey{Scope: t.Scope, Agent: t.Agent, Project: t.Project, Name: name}
}

func (t skillsTarget) label(name string) string {
	s := fmt.Sprintf("%s/%s/%s", t.Agent, t.Scope, name)
	if t.Project != "" {
		s += fmt.Sprintf(" (%s)", t.Project)
	}
	return s
}

func resolveProject(project string) (string, error) {
	if project == "" {
		return os.Getwd()
	}
	return filepath.Abs(project)
}

// serverURL is the configured server, used to key the local sync state.
func serverURL() string {
	cfg, _ := client.LoadConfig()
	return cfg.Server
}

func hostname() string {
	host, _ := os.Hostname()
	if host == "" {
		host = "unknown"
	}
	return host
}

func stateGet(st *bundle.State, t skillsTarget, name string) bundle.Entry {
	return st.Get(serverURL(), t.Scope, t.Agent, t.Project, name)
}

func stateSet(st *bundle.State, t skillsTarget, name string, version int, manifest map[string]string) error {
	return st.Set(serverURL(), t.Scope, t.Agent, t.Project, name, version, manifest)
}

// ---- push --skills ----

func pushSkills(c *client.Client, agentList, scopes, project, only string, force, dryRun bool) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if strings.Contains(scopes, "project") && project == "" {
		if project, err = resolveProject(""); err != nil {
			return err
		}
	}
	targets, warnings := skillsTargets(agentList, scopes, home, project)
	for _, w := range warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w)
	}
	st, err := bundle.LoadState()
	if err != nil {
		return err
	}
	failures, matched := 0, 0
	for _, t := range targets {
		units, warns := t.Root.Units()
		for _, w := range warns {
			fmt.Fprintf(os.Stderr, "warning: %s\n", w)
		}
		present := map[string]bool{}
		for _, u := range units {
			if only != "" && u.Name != only {
				continue
			}
			matched++
			present[u.Name] = true
			b, blobs, warns, err := bundle.Build(t.Root, u)
			for _, w := range warns {
				fmt.Fprintf(os.Stderr, "warning: %s\n", w)
			}
			if err != nil {
				fmt.Fprintf(os.Stderr, "push failed  %s: %v\n", t.label(u.Name), err)
				failures++
				continue
			}
			if len(b.Files) == 0 {
				continue
			}
			entry := stateGet(st, t, u.Name)
			if entry.Version > 0 && bundle.Diff(b, api.Bundle{Files: manifestFiles(entry.Manifest)}).Empty() {
				fmt.Printf("unchanged  %s  (v%d, %d files)\n", t.label(u.Name), entry.Version, len(b.Files))
				continue
			}
			if dryRun {
				fmt.Printf("would push  %s  (%d files, parent v%d)\n", t.label(u.Name), len(b.Files), entry.Version)
				continue
			}
			b.Agent, b.Project, b.Parent, b.Host = t.Agent, t.Project, entry.Version, hostname()
			if err := uploadBlobs(c, blobs); err != nil {
				fmt.Fprintf(os.Stderr, "push failed  %s: %v\n", t.label(u.Name), err)
				failures++
				continue
			}
			res, err := c.PutBundle(t.key(u.Name), b, force)
			if err != nil {
				if errors.Is(err, client.ErrStale) {
					fmt.Fprintf(os.Stderr, "push failed  %s: the server has a newer version than the one you last synced (v%d).\n"+
						"  Run `stift pull --skills --scope %s` to merge it first, or `stift push --skills --force` to overwrite.\n",
						t.label(u.Name), entry.Version, t.Scope)
				} else {
					fmt.Fprintf(os.Stderr, "push failed  %s: %v\n", t.label(u.Name), err)
				}
				failures++
				continue
			}
			if err := stateSet(st, t, u.Name, res.Version, bundle.Manifest(b)); err != nil {
				return err
			}
			fmt.Printf("pushed     %s  v%d (%d files)\n", t.label(u.Name), res.Version, len(b.Files))
		}
		// Units we synced before but which are gone locally are left on the
		// server: deleting remote history is an explicit action.
		if only == "" {
			gone := st.Names(serverURL(), t.Scope, t.Agent, t.Project)
			sort.Strings(gone)
			for _, n := range gone {
				if !present[n] {
					fmt.Printf("missing    %s  (removed locally; server keeps v%d, `stift skills delete %s` to remove)\n",
						t.label(n), stateGet(st, t, n).Version, n)
				}
			}
		}
	}
	if only != "" && matched == 0 {
		return fmt.Errorf("no local unit named %q", only)
	}
	if failures > 0 {
		return fmt.Errorf("%d unit(s) failed to push", failures)
	}
	return nil
}

func uploadBlobs(c *client.Client, blobs map[string]string) error {
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

func manifestFiles(m map[string]string) []api.BundleFile {
	var out []api.BundleFile
	for p, sha := range m {
		out = append(out, api.BundleFile{Path: p, SHA256: sha})
	}
	return out
}

// ---- pull --skills ----

func pullSkills(c *client.Client, agentList, scopes, project, only string, version int, force, dryRun bool) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if version > 0 && only == "" {
		return fmt.Errorf("--version needs --name: versions are per unit")
	}
	if strings.Contains(scopes, "project") && project == "" {
		if project, err = resolveProject(""); err != nil {
			return err
		}
	}
	targets, warnings := skillsTargets(agentList, scopes, home, project)
	for _, w := range warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w)
	}
	st, err := bundle.LoadState()
	if err != nil {
		return err
	}
	explicit := len(strings.Split(scopes, ",")) == 1
	failures := 0
	fetch := func(sha string) (io.ReadCloser, error) { return c.GetBlob(sha) }
	for _, t := range targets {
		var remotes []api.Bundle
		if version > 0 {
			b, err := c.GetBundle(t.key(only), version)
			if err != nil {
				fmt.Fprintf(os.Stderr, "pull failed  %s: %v\n", t.label(only), err)
				failures++
				continue
			}
			remotes = []api.Bundle{b}
		} else {
			remotes, err = c.ListBundles(client.BundleFilter{Scope: t.Scope, Agent: t.Agent, Project: t.Project, Name: only})
			if err != nil {
				return err
			}
		}
		present := map[string]bool{}
		for _, remote := range remotes {
			present[remote.Name] = true
			if !agents.ValidUnitName(remote.Name) {
				fmt.Fprintf(os.Stderr, "pull failed  %s: refusing unsafe unit name\n", t.label(remote.Name))
				failures++
				continue
			}
			entry := stateGet(st, t, remote.Name)
			dir := agents.UnitDir(t.Root.BaseDir, remote.Name, bundle.Paths(remote))
			res, err := bundle.Apply(remote, fetch, dir, entry.Manifest, force, dryRun)
			if err != nil {
				fmt.Fprintf(os.Stderr, "pull failed  %s: %v\n", t.label(remote.Name), err)
				failures++
				continue
			}
			reportApply(t.label(remote.Name), remote.Version, res, dryRun)
			if dryRun {
				continue
			}
			// Record what is now on disk: remote content for files we wrote or
			// that matched, the old base entry for conflicts we left alone.
			manifest := bundle.Manifest(remote)
			for _, p := range res.Conflicts {
				if sha, ok := entry.Manifest[p]; ok {
					manifest[p] = sha
				} else {
					delete(manifest, p)
				}
			}
			if err := stateSet(st, t, remote.Name, remote.Version, manifest); err != nil {
				return err
			}
			if t.Scope == "org" {
				linkOrgUnit(home, t.Agent, remote.Name, dir, bundle.Paths(remote))
			}
		}
		if len(remotes) == 0 && explicit && (only != "" || version == 0) {
			fmt.Printf("no %s/%s units on the server\n", t.Agent, t.Scope)
		}
		if only != "" || version > 0 {
			continue
		}
		// Units deleted on the server since our last sync: remove local files
		// that are still as we left them.
		gone := st.Names(serverURL(), t.Scope, t.Agent, t.Project)
		sort.Strings(gone)
		for _, n := range gone {
			if present[n] || !agents.ValidUnitName(n) {
				continue
			}
			entry := stateGet(st, t, n)
			dir := agents.UnitDir(t.Root.BaseDir, n, manifestPaths(entry.Manifest))
			res, err := bundle.Apply(api.Bundle{}, fetch, dir, entry.Manifest, force, dryRun)
			if err != nil {
				fmt.Fprintf(os.Stderr, "pull failed  %s: %v\n", t.label(n), err)
				failures++
				continue
			}
			verb := "removed"
			if dryRun {
				verb = "would remove"
			}
			fmt.Printf("%-10s %s  (deleted on server): %d deleted", verb, t.label(n), len(res.Deleted))
			if len(res.Conflicts) > 0 {
				fmt.Printf(", %d locally modified (kept; use --force to remove)", len(res.Conflicts))
			}
			fmt.Println()
			if dryRun {
				continue
			}
			if t.Scope == "org" {
				unlinkOrgUnit(home, t.Agent, n)
			}
			if len(res.Conflicts) == 0 {
				os.Remove(dir) // empty unit dir, if any
				if err := st.Forget(serverURL(), t.Scope, t.Agent, t.Project, n); err != nil {
					return err
				}
			}
		}
	}
	if failures > 0 {
		return fmt.Errorf("%d unit(s) failed to pull", failures)
	}
	return nil
}

func reportApply(label string, version int, res bundle.ApplyResult, dryRun bool) {
	verb := "pulled"
	if dryRun {
		verb = "would pull"
	}
	fmt.Printf("%-10s %s  v%d: %d written, %d deleted, %d unchanged", verb, label, version,
		len(res.Written), len(res.Deleted), res.Unchanged)
	if len(res.Conflicts) > 0 {
		fmt.Printf(", %d locally modified (kept; use --force to overwrite)", len(res.Conflicts))
	}
	fmt.Println()
	if dryRun {
		for _, p := range res.Written {
			fmt.Printf("  + %s\n", p)
		}
		for _, p := range res.Deleted {
			fmt.Printf("  - %s\n", p)
		}
		for _, p := range res.Conflicts {
			fmt.Printf("  ! %s (modified locally)\n", p)
		}
	}
}

func manifestPaths(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for p := range m {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// userConfigRoot returns the user-scope config root of an agent, built-in or
// custom, or false when the agent has none.
func userConfigRoot(home, agent string) (agents.ConfigRoot, bool) {
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
func orgLink(home, agent, name, dir string, files []string) (link, target string, ok bool) {
	root, found := userConfigRoot(home, agent)
	if !found || !strings.Contains(name, "/") {
		return "", "", false
	}
	target = dir
	if len(files) == 1 && dir != filepath.Join(orgDir(home, agent), filepath.FromSlash(name)) {
		target = filepath.Join(dir, files[0]) // file unit
	}
	rel, err := filepath.Rel(orgDir(home, agent), target)
	if err != nil || !filepath.IsLocal(rel) {
		return "", "", false
	}
	return filepath.Join(root.BaseDir, rel), target, true
}

// linkOrgUnit symlinks one pulled org unit into the agent's user config
// directory (for Claude Code: ~/.claude/skills/<name> -> ~/.stift/org/claude/skills/<name>).
// An existing entry that is not one of our links is left alone with a warning.
func linkOrgUnit(home, agent, name, dir string, files []string) {
	link, target, ok := orgLink(home, agent, name, dir, files)
	if !ok {
		if _, found := userConfigRoot(home, agent); !found {
			fmt.Fprintf(os.Stderr, "warning: %s: no user config directory known; org unit left in %s\n", agent, dir)
		} else {
			fmt.Fprintf(os.Stderr, "note: org unit %s is not linked (top-level files are not merged); see %s\n", name, dir)
		}
		return
	}
	src := orgDir(home, agent) + string(filepath.Separator)
	if cur, err := os.Readlink(link); err == nil {
		if cur == target {
			return
		}
		if strings.HasPrefix(cur, src) {
			os.Remove(link)
		}
	}
	if _, err := os.Lstat(link); err == nil {
		fmt.Fprintf(os.Stderr, "warning: %s exists and is not an org link; skipped\n", link)
		return
	}
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "warning: %v\n", err)
		return
	}
	if err := os.Symlink(target, link); err != nil {
		fmt.Fprintf(os.Stderr, "warning: link %s: %v\n", link, err)
	}
}

// unlinkOrgUnit removes the link(s) we created for an org unit that no
// longer exists on the server.
func unlinkOrgUnit(home, agent, name string) {
	root, ok := userConfigRoot(home, agent)
	if !ok || !strings.Contains(name, "/") {
		return
	}
	src := orgDir(home, agent) + string(filepath.Separator)
	parent := filepath.Join(root.BaseDir, filepath.FromSlash(path.Dir(name)))
	for _, cand := range []string{filepath.Join(root.BaseDir, filepath.FromSlash(name)), filepath.Join(parent, path.Base(name)+".md")} {
		if cur, err := os.Readlink(cand); err == nil && strings.HasPrefix(cur, src) {
			os.Remove(cand)
		}
	}
}

// ---- stift skills ----

func cmdSkills(args []string) error {
	fs := flag.NewFlagSet("skills", flag.ExitOnError)
	agent := fs.String("agent", "claude", "agent whose units to inspect")
	scope := fs.String("scope", "user", "unit scope: user, project or org")
	project := fs.String("project", "", "project directory for --scope project (default: current directory)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: stift skills list [--scope S] [--agent A]")
		fmt.Fprintln(os.Stderr, "       stift skills history NAME [--scope S] [--agent A]")
		fmt.Fprintln(os.Stderr, "       stift skills diff NAME [N]       compare local files with server version N (default HEAD)")
		fmt.Fprintln(os.Stderr, "       stift skills rollback NAME N     publish version N again as a new version")
		fmt.Fprintln(os.Stderr, "       stift skills delete NAME         delete a unit and its history from the server")
		fmt.Fprintln(os.Stderr, "NAME is a unit such as skills/deploy, agents/reviewer, commands/fix-tests or CLAUDE.md.")
		fs.PrintDefaults()
	}
	if len(args) == 0 {
		fs.Usage()
		os.Exit(2)
	}
	sub := args[0]
	// Allow flags after positionals: "stift skills history skills/x --scope org".
	var pos []string
	rest := args[1:]
	for {
		fs.Parse(rest)
		if fs.NArg() == 0 {
			break
		}
		pos = append(pos, fs.Arg(0))
		rest = fs.Args()[1:]
	}
	narg := func() int { return len(pos) }
	arg := func(i int) string { return pos[i] }
	c, err := client.Require()
	if err != nil {
		return err
	}
	proj := ""
	if *scope == "project" {
		if proj, err = resolveProject(*project); err != nil {
			return err
		}
	}
	t := skillsTarget{Agent: *agent, Scope: *scope, Project: proj}
	unitArg := func() (string, error) {
		if narg() < 1 {
			return "", fmt.Errorf("usage: stift skills %s NAME", sub)
		}
		n := arg(0)
		if !agents.ValidUnitName(n) {
			return "", fmt.Errorf("invalid unit name %q", n)
		}
		return n, nil
	}

	switch sub {
	case "list", "ls":
		f := client.BundleFilter{}
		if isFlagSet(fs, "agent") {
			f.Agent = *agent
		}
		if isFlagSet(fs, "scope") {
			f.Scope = *scope
			f.Project = proj
		}
		if narg() == 1 {
			f.Name = arg(0)
		}
		list, err := c.ListBundles(f)
		if err != nil {
			return err
		}
		if len(list) == 0 {
			fmt.Println("no units on the server")
			return nil
		}
		fmt.Printf("%-8s %-8s %-28s %-4s %-6s %-19s %s\n", "AGENT", "SCOPE", "NAME", "VER", "FILES", "UPDATED", "PROJECT")
		for _, b := range list {
			fmt.Printf("%-8s %-8s %-28s v%-3d %-6d %-19s %s\n", b.Agent, b.Scope, b.Name, b.Version, len(b.Files),
				b.Created.Local().Format("2006-01-02 15:04:05"), b.Project)
			for _, s := range b.Skills {
				fmt.Printf("    %-24s %s\n", oneOf(s.Name, s.Path), s.Description)
			}
		}
	case "history":
		name, err := unitArg()
		if err != nil {
			return err
		}
		hist, err := c.BundleHistory(t.key(name))
		if err != nil {
			return err
		}
		for _, b := range hist {
			fmt.Printf("v%-4d parent v%-4d %-19s %-12s %-12s %d files\n", b.Version, b.Parent,
				b.Created.Local().Format("2006-01-02 15:04:05"), b.Author, b.Host, len(b.Files))
		}
	case "diff":
		name, err := unitArg()
		if err != nil {
			return err
		}
		version := 0
		if narg() == 2 {
			if version, err = strconv.Atoi(arg(1)); err != nil {
				return fmt.Errorf("version must be a number")
			}
		}
		remote, err := c.GetBundle(t.key(name), version)
		if err != nil {
			return err
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		targets, _ := skillsTargets(*agent, *scope, home, proj)
		if len(targets) == 0 {
			return fmt.Errorf("no local config root for %s/%s", *agent, *scope)
		}
		local := api.Bundle{}
		units, _ := targets[0].Root.Units()
		for _, u := range units {
			if u.Name == name {
				if local, _, _, err = bundle.Build(targets[0].Root, u); err != nil {
					return err
				}
			}
		}
		ch := bundle.Diff(local, remote)
		if ch.Empty() {
			fmt.Printf("%s: local files match server v%d\n", name, remote.Version)
			return nil
		}
		fmt.Printf("%s: local vs server v%d:\n", name, remote.Version)
		for _, p := range ch.Added {
			fmt.Printf("  + %s  (local only)\n", p)
		}
		for _, p := range ch.Modified {
			fmt.Printf("  ~ %s  (differs)\n", p)
		}
		for _, p := range ch.Removed {
			fmt.Printf("  - %s  (server only)\n", p)
		}
	case "rollback":
		name, err := unitArg()
		if err != nil {
			return err
		}
		if narg() != 2 {
			return fmt.Errorf("usage: stift skills rollback NAME N")
		}
		version, err := strconv.Atoi(arg(1))
		if err != nil || version < 1 {
			return fmt.Errorf("version must be a positive number")
		}
		key := t.key(name)
		old, err := c.GetBundle(key, version)
		if err != nil {
			return err
		}
		head, err := c.GetBundle(key, 0)
		if err != nil {
			return err
		}
		b := api.Bundle{Scope: key.Scope, Agent: key.Agent, Project: key.Project, Name: name, Parent: head.Version, Host: hostname(), Files: old.Files}
		res, err := c.PutBundle(key, b, false)
		if err != nil {
			return err
		}
		fmt.Printf("%s: published v%d as v%d; run `stift pull --skills --scope %s` to apply it locally\n", name, version, res.Version, key.Scope)
	case "delete", "rm":
		name, err := unitArg()
		if err != nil {
			return err
		}
		if err := c.DeleteBundle(t.key(name)); err != nil {
			return err
		}
		fmt.Printf("deleted %s\n", t.label(name))
	default:
		fs.Usage()
		os.Exit(2)
	}
	return nil
}

func isFlagSet(fs *flag.FlagSet, name string) bool {
	set := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == name {
			set = true
		}
	})
	return set
}
