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
	"github.com/stift-sh/stift/internal/registry"
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
			if t.Scope == "org" && !dryRun {
				if err := s.Report(t.Agent, remote.Name, remote.Version, api.InstallReportFromSubscribe); err != nil {
					warnf(fmt.Sprintf("could not report the pull of %s to the server: %v", remote.Name, err))
				}
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
	replace := fs.Bool("replace", false, "install: turn an org-scope subscription (symlink) into a copy")
	upgrade := fs.Bool("upgrade", false, "install: re-copy over an existing install")
	force := fs.Bool("force", false, "install: overwrite local modifications")
	license := fs.String("license", "", "publish: SPDX identifier or LicenseRef-<name> (required on the first publish)")
	pubName := fs.String("name", "", "publish: public name (default: the unit's last segment; fixed after the first publish)")
	version := fs.Int("version", 0, "publish: source version to publish (default: newest)")
	regURL := fs.String("registry", "", "search/install @ref: registry URL (default: STIFT_REGISTRY_URL, the config file, then the logged-in server or "+registry.DefaultURL+")")
	limit := fs.Int("limit", 20, "search: results per page (max 50)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: stift skills list [--scope S] [--agent A]")
		fmt.Fprintln(os.Stderr, "       stift skills history NAME [--scope S] [--agent A]")
		fmt.Fprintln(os.Stderr, "       stift skills diff NAME [N]       compare local files with server version N (default HEAD)")
		fmt.Fprintln(os.Stderr, "       stift skills rollback NAME N     publish version N again as a new version")
		fmt.Fprintln(os.Stderr, "       stift skills delete NAME         delete a unit and its history from the server")
		fmt.Fprintln(os.Stderr, "       stift skills install NAME [--agent A] [--replace] [--upgrade] [--force]")
		fmt.Fprintln(os.Stderr, "                                        copy an org unit into your own config (a fork you may edit)")
		fmt.Fprintln(os.Stderr, "       stift skills install @ORG/NAME[@N] [--registry URL] [--agent A] [--upgrade] [--force]")
		fmt.Fprintln(os.Stderr, "                                        install a published skill from a registry (no login needed)")
		fmt.Fprintln(os.Stderr, "       stift skills outdated            installed copies that are behind the org head or the registry")
		fmt.Fprintln(os.Stderr, "       stift skills publish NAME --license L [--name PUBLIC] [--version N] [--agent A]")
		fmt.Fprintln(os.Stderr, "                                        publish an org skill as @<org-slug>/<name> (admins)")
		fmt.Fprintln(os.Stderr, "       stift skills unpublish @ORG/NAME[@N]   hide a version (or the skill) from search and latest")
		fmt.Fprintln(os.Stderr, "       stift skills restore @ORG/NAME[@N]     make it visible again")
		fmt.Fprintln(os.Stderr, "       stift skills search [QUERY] [--registry URL] [--limit N]")
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
	// Registry reads (search, install @ref, outdated for registry installs)
	// work without a login, so the client is only required by the
	// subcommands that talk to the org.
	var c *client.Client
	login := func() (*client.Client, error) {
		var err error
		if c == nil {
			c, err = client.Require()
		}
		return c, err
	}
	home, err := os.UserHomeDir()
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
	// refArg parses the @org/name[@N] positional of unpublish and restore.
	// A bare name is accepted too; an org that is not the caller's is
	// refused before the server gets a request it cannot mean.
	refArg := func(c *client.Client) (string, int, error) {
		if narg() < 1 {
			return "", 0, fmt.Errorf("usage: stift skills %s @ORG/NAME[@N]", sub)
		}
		if !registry.IsRef(arg(0)) {
			return arg(0), 0, nil
		}
		r, err := registry.Parse(arg(0))
		if err != nil {
			return "", 0, err
		}
		if w, err := c.Whoami(); err == nil && w.Org.Slug != "" && w.Org.Slug != r.Org {
			return "", 0, fmt.Errorf("%s is not in your org (@%s)", r.Base(), w.Org.Slug)
		}
		return r.Name, r.Version, nil
	}

	switch sub {
	case "list", "ls":
		c, err := login()
		if err != nil {
			return err
		}
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
		c, err := login()
		if err != nil {
			return err
		}
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
		c, err := login()
		if err != nil {
			return err
		}
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
		c, err := login()
		if err != nil {
			return err
		}
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
	case "install":
		if narg() >= 1 && registry.IsRef(arg(0)) {
			return installFromRegistry(arg(0), *regURL, *agent, isFlagSet(fs, "agent"), home,
				skillsync.InstallOptions{Replace: *replace, Upgrade: *upgrade, Force: *force})
		}
		c, err := login()
		if err != nil {
			return err
		}
		name, err := unitArg()
		if err != nil {
			return err
		}
		s, err := skillsync.New(c, home, warnf)
		if err != nil {
			return err
		}
		org := skillsync.Target{Agent: *agent, Scope: "org"}
		remote, err := c.GetBundle(org.Key(name), 0)
		if err != nil {
			return err
		}
		res, err := s.Install(*agent, remote, skillsync.InstallOptions{Replace: *replace, Upgrade: *upgrade, Force: *force})
		if err != nil {
			return err
		}
		reportInstall(name, res)
		if err := s.Report(*agent, name, res.Version, api.InstallReportFromInstall); err != nil {
			warnf(fmt.Sprintf("could not report the install to the server: %v", err))
		}
	case "outdated":
		return skillsOutdated(home)
	case "delete", "rm":
		c, err := login()
		if err != nil {
			return err
		}
		name, err := unitArg()
		if err != nil {
			return err
		}
		if err := c.DeleteBundle(t.Key(name)); err != nil {
			return err
		}
		fmt.Printf("deleted %s\n", t.Label(name))
	case "publish":
		c, err := login()
		if err != nil {
			return err
		}
		name, err := unitArg()
		if err != nil {
			return err
		}
		v, err := c.Publish(api.PublishRequest{Agent: *agent, Unit: name, Name: *pubName, License: *license, Version: *version})
		if err != nil {
			return err
		}
		ref := registry.Ref{Org: v.Org, Name: v.Name}
		fmt.Printf("published %s/org/%s v%d as %s v%d (%d files)\n", *agent, name, v.SourceVersion, ref.Base(), v.Version, len(v.Files))
		fmt.Printf("  install anywhere: stift skills install %s --registry %s\n", ref.Base(), c.Server())
	case "unpublish":
		c, err := login()
		if err != nil {
			return err
		}
		name, version, err := refArg(c)
		if err != nil {
			return err
		}
		if err := c.Unpublish(name, version); err != nil {
			return err
		}
		if version > 0 {
			fmt.Printf("unpublished %s v%d: hidden from search and latest, still resolves by number; `stift skills restore %s@%d` brings it back\n", name, version, name, version)
		} else {
			fmt.Printf("unpublished %s: hidden from search and latest, versions still resolve by number; `stift skills restore %s` brings it back\n", name, name)
		}
	case "restore":
		c, err := login()
		if err != nil {
			return err
		}
		name, version, err := refArg(c)
		if err != nil {
			return err
		}
		if err := c.RestorePublished(name, version); err != nil {
			return err
		}
		if version > 0 {
			fmt.Printf("restored %s v%d\n", name, version)
		} else {
			fmt.Printf("restored %s\n", name)
		}
	case "search":
		q := ""
		if narg() >= 1 {
			q = strings.Join(pos, " ")
		}
		reg, err := searchRegistry(*regURL)
		if err != nil {
			return err
		}
		page, err := reg.Search(q, *limit, "")
		if err != nil {
			return err
		}
		if len(page.Skills) == 0 {
			fmt.Printf("no published skills match on %s\n", reg.URL())
			return nil
		}
		fmt.Printf("%-32s %-5s %-12s %-8s %s\n", "SKILL", "VER", "LICENSE", "AGENT", "DESCRIPTION")
		for _, sk := range page.Skills {
			fmt.Printf("%-32s v%-4d %-12s %-8s %s\n", "@"+sk.Org+"/"+sk.Name, sk.Latest, sk.License, sk.Agent, sk.Description)
		}
		if page.Next != "" {
			fmt.Printf("more on %s; narrow the query or raise --limit\n", reg.URL())
		}
	default:
		fs.Usage()
		os.Exit(2)
	}
	return nil
}

func reportInstall(name string, res skillsync.InstallResult) {
	verb := "installed"
	if res.Upgraded {
		verb = fmt.Sprintf("upgraded v%d →", res.Previous)
	}
	fmt.Printf("%s %s v%d → %s: %d written, %d unchanged", verb, name, res.Version, res.Dir, len(res.Apply.Written), res.Apply.Unchanged)
	if len(res.Apply.Conflicts) > 0 {
		fmt.Printf(", %d locally modified (kept; use --force to overwrite)", len(res.Apply.Conflicts))
	}
	fmt.Println()
	if res.Replaced {
		fmt.Printf("the org subscription link was replaced; this copy no longer follows org updates (`stift skills outdated` shows when it falls behind)\n")
	}
	if res.Evicted != "" {
		fmt.Printf("replaced the copy installed from %s\n", res.Evicted)
	}
}

// searchRegistry picks the registry for a search: an explicit URL
// (--registry, STIFT_REGISTRY_URL, `registry` in the config file), else the
// logged-in server when it advertises the registry feature, else the
// default registry.
func searchRegistry(flagURL string) (*client.Registry, error) {
	cfg, _ := client.LoadConfig()
	if u := oneOf(flagURL, cfg.Registry); u != "" {
		return client.NewRegistry(u), nil
	}
	if cfg.Server != "" {
		if reg := client.NewRegistry(cfg.Server); reg.HasRegistry() {
			return reg, nil
		}
	}
	return client.NewRegistry(registry.DefaultURL), nil
}

// resolveRef finds a reference: on the explicit registry when one is
// configured, else on the logged-in server (if it is a registry and has
// the ref) and then the default registry. A miss names the registry asked.
func resolveRef(flagURL string, ref registry.Ref) (*client.Registry, api.RegistrySkill, error) {
	cfg, _ := client.LoadConfig()
	var candidates []string
	if u := oneOf(flagURL, cfg.Registry); u != "" {
		candidates = []string{u}
	} else {
		if cfg.Server != "" && client.NewRegistry(cfg.Server).HasRegistry() {
			candidates = append(candidates, cfg.Server)
		}
		if strings.TrimRight(cfg.Server, "/") != registry.DefaultURL {
			candidates = append(candidates, registry.DefaultURL)
		}
	}
	var rs api.RegistrySkill
	for i, u := range candidates {
		reg := client.NewRegistry(u)
		rs, err := reg.Get(ref.Org, ref.Name, ref.Version)
		if err == nil {
			return reg, rs, nil
		}
		if !errors.Is(err, client.ErrNotFound) || i == len(candidates)-1 {
			if errors.Is(err, client.ErrNotFound) {
				return nil, rs, fmt.Errorf("%s not found on %s (--registry URL or STIFT_REGISTRY_URL asks another registry)", ref, u)
			}
			return nil, rs, err
		}
	}
	return nil, rs, fmt.Errorf("%s: no registry to ask", ref)
}

// installFromRegistry is `stift skills install @org/name[@N]`: resolve the
// ref, then copy it with checksum verification. No login is needed.
func installFromRegistry(refStr, flagURL, agent string, agentSet bool, home string, opt skillsync.InstallOptions) error {
	ref, err := registry.Parse(refStr)
	if err != nil {
		return err
	}
	reg, rs, err := resolveRef(flagURL, ref)
	if err != nil {
		return err
	}
	if !agentSet && rs.Skill.Agent != "" {
		agent = rs.Skill.Agent
	}
	s, err := skillsync.New(nil, home, warnf)
	if err != nil {
		return err
	}
	res, err := s.InstallRegistry(agent, reg, ref, rs, opt)
	if err != nil {
		return err
	}
	reportInstall(ref.Base(), res)
	if !rs.Version.UnpublishedAt.IsZero() {
		warnf(fmt.Sprintf("%s v%d was unpublished; it still installs but `stift skills outdated` will flag it", ref.Base(), res.Version))
	}
	return nil
}

// skillsOutdated lists every install in the state file, org and registry,
// and where each stands against its source.
func skillsOutdated(home string) error {
	st, err := bundle.LoadState()
	if err != nil {
		return err
	}
	refs := st.AllInstalls()
	if len(refs) == 0 {
		fmt.Println("nothing installed")
		return nil
	}
	cfg, _ := client.LoadConfig()
	var c *client.Client
	if cfg.Server != "" && cfg.Token != "" {
		c = client.New(cfg.Server, cfg.Token)
	}
	fmt.Printf("%-8s %-28s %-9s %-9s %s\n", "AGENT", "NAME", "INSTALLED", "LATEST", "STATUS")
	behind := 0
	for _, r := range refs {
		e := st.Installs[bundle.InstallKey(r.Server, r.Agent, r.Name)]
		status, latest := "up to date", "-"
		switch e.From {
		case "registry":
			ref, err := registry.Parse(e.Ref)
			if err != nil {
				status = "bad state entry: " + err.Error()
				break
			}
			cur, err := client.NewRegistry(e.Registry).Get(ref.Org, ref.Name, 0)
			switch {
			case errors.Is(err, client.ErrNotFound):
				status = "unpublished on " + e.Registry
			case err != nil:
				status = "unreachable: " + err.Error()
			case cur.Version.Version > e.Version:
				latest = fmt.Sprintf("v%d", cur.Version.Version)
				status = fmt.Sprintf("behind; `stift skills install %s --upgrade --registry %s`", e.Ref, e.Registry)
				behind++
			case cur.Version.Version < e.Version:
				latest = fmt.Sprintf("v%d", cur.Version.Version)
				status = fmt.Sprintf("unpublished; latest is v%d, `stift skills install %s --upgrade --force --registry %s` goes back to it", cur.Version.Version, e.Ref, e.Registry)
			default:
				latest = fmt.Sprintf("v%d", cur.Version.Version)
			}
		default:
			if c == nil || strings.TrimRight(cfg.Server, "/") != r.Server {
				status = "not logged in to " + r.Server
				break
			}
			head, err := c.GetBundle(client.BundleKey{Scope: "org", Agent: r.Agent, Name: r.Name}, 0)
			if err != nil {
				status = "gone from org: " + err.Error()
				break
			}
			latest = fmt.Sprintf("v%d", head.Version)
			if head.Version > e.Version {
				status = "behind; `stift skills install " + r.Name + " --upgrade --agent " + r.Agent + "`"
				behind++
			}
		}
		fmt.Printf("%-8s %-28s %-9s %-9s %s\n", r.Agent, r.Name, fmt.Sprintf("v%d", e.Version), latest, status)
	}
	if behind > 0 {
		return fmt.Errorf("%d install(s) behind", behind)
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
