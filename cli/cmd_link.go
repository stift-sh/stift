package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/stift-sh/stift/internal/client"
	"github.com/stift-sh/stift/internal/daemon"
	"github.com/stift-sh/stift/internal/gitrepo"
)

// cmdLink records that the current directory maps to a project id and pulls
// that project's sessions immediately. Later sessions sync automatically.
func cmdLink(args []string) error {
	fs := flag.NewFlagSet("link", flag.ExitOnError)
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: stift link [project-id]")
		fmt.Fprintln(os.Stderr, "  Links the current directory (default id: repo name) and pulls its sessions.")
	}
	fs.Parse(args)

	dir, err := currentDir()
	if err != nil {
		return err
	}
	projectID := gitrepo.ProjectID(dir)
	if fs.NArg() >= 1 {
		projectID = fs.Arg(0)
	}
	if projectID == "" {
		return fmt.Errorf("could not determine a project id for %s; pass one: stift link <id>", dir)
	}

	links, err := client.LoadLinks()
	if err != nil {
		return err
	}
	found := false
	for i := range links {
		if links[i].Dir == dir {
			links[i].ProjectID = projectID
			found = true
			break
		}
	}
	if !found {
		links = append(links, client.Link{Dir: dir, ProjectID: projectID})
	}
	if _, err := client.SaveLinks(links); err != nil {
		return err
	}
	fmt.Printf("linked %s -> %s\n", dir, projectID)

	c, err := client.Require()
	if err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	host := resolveHost()
	n, err := daemon.ReconcileOnce(c, home, host, dir, projectID, log.New(os.Stdout, "", 0))
	if err != nil {
		return err
	}
	if n == 0 {
		fmt.Println("no new sessions to pull (they'll sync as they appear)")
	} else {
		fmt.Printf("pulled %d session(s)\n", n)
	}
	return nil
}

// cmdUnlink removes the link for the current directory.
func cmdUnlink(args []string) error {
	dir, err := currentDir()
	if err != nil {
		return err
	}
	links, err := client.LoadLinks()
	if err != nil {
		return err
	}
	out := make([]client.Link, 0, len(links))
	removed := false
	for _, l := range links {
		if l.Dir == dir {
			removed = true
			continue
		}
		out = append(out, l)
	}
	if !removed {
		fmt.Printf("no link for %s\n", dir)
		return nil
	}
	if _, err := client.SaveLinks(out); err != nil {
		return err
	}
	fmt.Printf("unlinked %s\n", dir)
	return nil
}

// cmdLinks lists all linked projects.
func cmdLinks(args []string) error {
	links, err := client.LoadLinks()
	if err != nil {
		return err
	}
	if len(links) == 0 {
		fmt.Println("no linked projects")
		return nil
	}
	for _, l := range links {
		fmt.Printf("%-30s %s\n", l.ProjectID, l.Dir)
	}
	return nil
}

func currentDir() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Abs(dir)
}
