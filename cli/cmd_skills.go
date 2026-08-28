package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/stift-sh/stift/internal/agents"
	"github.com/stift-sh/stift/internal/api"
	"github.com/stift-sh/stift/internal/bundle"
	"github.com/stift-sh/stift/internal/client"
	"github.com/stift-sh/stift/internal/skillsync"
)

func resolveProject(project string) (string, error) {
	if project == "" {
		return os.Getwd()
	}
	return filepath.Abs(project)
}

func warnf(msg string) { fmt.Fprintf(os.Stderr, "warning: %s\n", msg) }

// skillsSyncer resolves the local config roots for the requested agents and
// scopes (project scope defaults to the working directory) and a Syncer.
func skillsSyncer(c *client.Client, agentList, scopes, project string) (*skillsync.Syncer, []skillsync.Target, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, nil, err
	}
	if strings.Contains(scopes, "project") && project == "" {
		if project, err = resolveProject(""); err != nil {
			return nil, nil, err
		}
	}
	targets, warnings := skillsync.Targets(agentList, scopes, home, project)
	for _, w := range warnings {
		warnf(w)
	}
	s, err := skillsync.New(c, home, warnf)
	return s, targets, err
}

// ---- push --skills ----

func pushSkills(c *client.Client, agentList, scopes, project, only string, force, dryRun bool) error {
	s, targets, err := skillsSyncer(c, agentList, scopes, project)
	if err != nil {
		return err
	}
	failures, matched := 0, 0
	for _, t := range targets {
		units, warns := t.Root.Units()
		for _, w := range warns {
			warnf(w)
		}
		present := map[string]bool{}
		for _, u := range units {
			if only != "" && u.Name != only {
				continue
			}
			matched++
			present[u.Name] = true
			b, blobs, err := s.Build(t, u)
			if err != nil {
				fmt.Fprintf(os.Stderr, "push failed  %s: %v\n", t.Label(u.Name), err)
				failures++
				continue
			}
			if len(b.Files) == 0 {
				continue
			}
			entry := s.Entry(t, u.Name)
			if skillsync.Unchanged(entry, b) {
				fmt.Printf("unchanged  %s  (v%d, %d files)\n", t.Label(u.Name), entry.Version, len(b.Files))
				continue
			}
			if dryRun {
				fmt.Printf("would push  %s  (%d files, parent v%d)\n", t.Label(u.Name), len(b.Files), entry.Version)
				continue
			}
			version, err := s.Push(t, b, blobs, force)
			if err != nil {
				if errors.Is(err, client.ErrStale) {
					fmt.Fprintf(os.Stderr, "push failed  %s: the server has a newer version than the one you last synced (v%d).\n"+
						"  Run `stift pull --skills --scope %s` to merge it first, or `stift push --skills --force` to overwrite.\n",
						t.Label(u.Name), entry.Version, t.Scope)
				} else {
					fmt.Fprintf(os.Stderr, "push failed  %s: %v\n", t.Label(u.Name), err)
				}
				failures++
				continue
			}
			fmt.Printf("pushed     %s  v%d (%d files)\n", t.Label(u.Name), version, len(b.Files))
		}
		// Units we synced before but which are gone locally are left on the
		// server: deleting remote history is an explicit action.
		if only == "" {
			for _, n := range s.Names(t) {
				if !present[n] {
					fmt.Printf("missing    %s  (removed locally; server keeps v%d, `stift skills delete %s` to remove)\n",
						t.Label(n), s.Entry(t, n).Version, n)
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

// ---- pull --skills ----

func pullSkills(c *client.Client, agentList, scopes, project, only string, version int, force, dryRun bool) error {
	if version > 0 && only == "" {
		return fmt.Errorf("--version needs --name: versions are per unit")
	}
	s, targets, err := skillsSyncer(c, agentList, scopes, project)
	if err != nil {
		return err
	}
	explicit := len(strings.Split(scopes, ",")) == 1
	failures := 0
	for _, t := range targets {
		var remotes []api.Bundle
		if version > 0 {
			b, err := c.GetBundle(t.Key(only), version)
			if err != nil {
				fmt.Fprintf(os.Stderr, "pull failed  %s: %v\n", t.Label(only), err)
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
			res, err := s.Pull(t, remote, force, dryRun)
			if err != nil {
				fmt.Fprintf(os.Stderr, "pull failed  %s: %v\n", t.Label(remote.Name), err)
				failures++
				continue
			}
			reportApply(t.Label(remote.Name), remote.Version, res, dryRun)
		}
		if len(remotes) == 0 && explicit && (only != "" || version == 0) {
			fmt.Printf("no %s/%s units on the server\n", t.Agent, t.Scope)
		}
		if only != "" || version > 0 {
			continue
		}
		// Units deleted on the server since our last sync: remove local files
		// that are still as we left them.
		for _, n := range s.Names(t) {
			if present[n] {
				continue
			}
			res, err := s.Remove(t, n, force, dryRun)
			if err != nil {
				fmt.Fprintf(os.Stderr, "pull failed  %s: %v\n", t.Label(n), err)
				failures++
				continue
			}
			verb := "removed"
			if dryRun {
				verb = "would remove"
			}
			fmt.Printf("%-10s %s  (deleted on server): %d deleted", verb, t.Label(n), len(res.Deleted))
			if len(res.Conflicts) > 0 {
				fmt.Printf(", %d locally modified (kept; use --force to remove)", len(res.Conflicts))
			}
			fmt.Println()
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
	t := skillsync.Target{Agent: *agent, Scope: *scope, Project: proj}
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
		hist, err := c.BundleHistory(t.Key(name))
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
		remote, err := c.GetBundle(t.Key(name), version)
		if err != nil {
			return err
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		targets, _ := skillsync.Targets(*agent, *scope, home, proj)
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
		key := t.Key(name)
		old, err := c.GetBundle(key, version)
		if err != nil {
			return err
		}
		head, err := c.GetBundle(key, 0)
		if err != nil {
			return err
		}
		b := api.Bundle{Scope: api.BundleScope(key.Scope), Agent: key.Agent, Project: key.Project, Name: name, Parent: head.Version, Host: skillsync.Hostname(), Files: old.Files}
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
		if err := c.DeleteBundle(t.Key(name)); err != nil {
			return err
		}
		fmt.Printf("deleted %s\n", t.Label(name))
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
