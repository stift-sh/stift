package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"stift/internal/agents"
)

func cmdAgents(args []string) error {
	fs := flag.NewFlagSet("agents", flag.ExitOnError)
	agentList := fs.String("agent", "", "comma-separated agents to scan (default: all)")
	project := fs.String("project", "", "project directory (default: current directory)")
	allProjects := fs.Bool("all-projects", false, "scan sessions from every project")
	fs.Parse(args)

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
	var names []string
	if *agentList != "" {
		names = strings.Split(*agentList, ",")
	}
	sessions, warnings := agents.Detect(names, home, proj)
	for _, w := range warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w)
	}
	if len(sessions) == 0 {
		fmt.Printf("no sessions found (agents scanned: %s)\n", strings.Join(agents.Names(), ", "))
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
	fmt.Fprintln(w, "AGENT\tSESSION\tPROJECT\tTITLE\tFILES\tMODIFIED")
	for _, s := range sessions {
		fmt.Fprintf(w, "%s\t%.12s\t%s\t%.60s\t%d\t%s\n",
			s.Agent, s.SessionID, oneOf(s.Project, "-"), oneOf(s.Title, "-"),
			len(s.Files), humanTime(s.ModTime))
	}
	return w.Flush()
}
