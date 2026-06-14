package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/stift-sh/stift/engine/api"
	"github.com/stift-sh/stift/engine/archive"
	"github.com/stift-sh/stift/internal/agents"
	"github.com/stift-sh/stift/internal/client"
)

func cmdPush(args []string) error {
	fs := flag.NewFlagSet("push", flag.ExitOnError)
	agentList := fs.String("agent", "", "comma-separated agents to push (default: all)")
	project := fs.String("project", "", "project directory (default: current directory)")
	allProjects := fs.Bool("all-projects", false, "push sessions from every project, not just the current one")
	latest := fs.Bool("latest", false, "push only the most recent session per agent")
	dryRun := fs.Bool("dry-run", false, "show what would be pushed without uploading")
	fs.Parse(args)

	c, err := client.Require()
	if err != nil && !*dryRun {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	proj := *project
	if proj == "" && !*allProjects {
		if proj, err = os.Getwd(); err != nil {
			return err
		}
	}
	if proj != "" {
		if proj, err = filepath.Abs(proj); err != nil {
			return err
		}
	}
	host, _ := os.Hostname()
	if host == "" {
		host = "unknown"
	}

	var names []string
	if *agentList != "" {
		names = strings.Split(*agentList, ",")
	}
	sessions, warnings := agents.Detect(names, home, proj)
	for _, w := range warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w)
	}
	if *latest {
		seen := map[string]bool{}
		var filtered []agents.LocalSession
		for _, s := range sessions { // already sorted newest first
			if !seen[s.Agent] {
				seen[s.Agent] = true
				filtered = append(filtered, s)
			}
		}
		sessions = filtered
	}
	if len(sessions) == 0 {
		where := "for project " + proj
		if proj == "" {
			where = "on this machine"
		}
		fmt.Printf("no agent sessions found %s\n", where)
		return nil
	}

	failures := 0
	for _, s := range sessions {
		label := fmt.Sprintf("%-8s %-12.12s %s", s.Agent, s.SessionID, oneOf(s.Title, s.Project, "-"))
		if *dryRun {
			fmt.Printf("would push  %s  (%d files)\n", label, len(s.Files))
			continue
		}
		tmp, err := os.CreateTemp("", "stift-push-*.tar.gz")
		if err != nil {
			return err
		}
		n, err := archive.Pack(tmp, s.BaseDir, s.Files)
		if cerr := tmp.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			os.Remove(tmp.Name())
			fmt.Fprintf(os.Stderr, "pack failed  %s: %v\n", label, err)
			failures++
			continue
		}
		res, err := c.Push(api.Session{
			Key:       s.Key(host),
			Agent:     s.Agent,
			SessionID: s.SessionID,
			Project:   s.Project,
			Host:      host,
			Title:     s.Title,
			Base:      s.Base,
			Files:     n,
			ModTime:   s.ModTime,
		}, tmp.Name())
		os.Remove(tmp.Name())
		if err != nil {
			fmt.Fprintf(os.Stderr, "push failed  %s: %v\n", label, err)
			failures++
			continue
		}
		fmt.Printf("%-9s  %s  [%s]\n", res.Status, label, res.Session.ID[:8])
	}
	if failures > 0 {
		return fmt.Errorf("%d of %d sessions failed to push", failures, len(sessions))
	}
	return nil
}

func oneOf(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
