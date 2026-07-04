package main

import (
	"fmt"
	"os"
	"sort"

	"github.com/stift-sh/stift/internal/agents"
	"github.com/stift-sh/stift/internal/client"
	"github.com/stift-sh/stift/internal/daemon"
	"github.com/stift-sh/stift/internal/gitrepo"
	"github.com/stift-sh/stift/internal/service"
)

func cmdStart(args []string) error {
	if err := service.Install(); err != nil {
		return err
	}
	fmt.Println("stift background sync started")
	return nil
}

func cmdStop(args []string) error {
	if err := service.Uninstall(); err != nil {
		return err
	}
	fmt.Println("stift background sync stopped")
	return nil
}

func cmdRestart(args []string) error {
	if err := service.Restart(); err != nil {
		return err
	}
	fmt.Println("stift background sync restarted")
	return nil
}

func cmdStatus(args []string) error {
	st, err := service.Status()
	if err != nil {
		return err
	}
	fmt.Println(st)
	printUnreconciled()
	return nil
}

// printUnreconciled is a best-effort passive surface for sessions that exist on
// the server under a project id with no matching local project here — the rare
// case where a folder was renamed or never linked. It never fails the command.
func printUnreconciled() {
	c, err := client.Require()
	if err != nil {
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	host := resolveHost()

	local := map[string]bool{}
	sessions, _ := agents.Detect(nil, home, "")
	for _, s := range sessions {
		if s.Project != "" {
			local[gitrepo.ProjectID(s.Project)] = true
		}
	}
	if links, err := client.LoadLinks(); err == nil {
		for _, l := range links {
			local[l.ProjectID] = true
		}
	}

	remote, err := c.List(client.ListFilter{})
	if err != nil {
		return
	}
	state, _ := daemon.LoadState()
	counts := map[string]int{}
	for _, sess := range remote {
		if sess.ProjectID == "" || sess.Host == host || local[sess.ProjectID] {
			continue
		}
		if state != nil && state.Restored[sess.ID] {
			continue
		}
		counts[sess.ProjectID]++
	}
	if len(counts) == 0 {
		return
	}
	ids := make([]string, 0, len(counts))
	for id := range counts {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	fmt.Println()
	for _, id := range ids {
		fmt.Printf("  %d session(s) under %q are on the server but not here —\n"+
			"    cd into that project and run `stift link` (or `stift pull --project-id %s`)\n", counts[id], id, id)
	}
}
