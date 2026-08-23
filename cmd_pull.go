package main

import (
	"archive/tar"
	"compress/gzip"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"

	"github.com/stift-sh/stift/engine/api"
	"github.com/stift-sh/stift/engine/archive"
	"github.com/stift-sh/stift/internal/client"
	"github.com/stift-sh/stift/internal/daemon"
)

func cmdPull(args []string) error {
	fs := flag.NewFlagSet("pull", flag.ExitOnError)
	agent := fs.String("agent", "", "with --latest: restrict to one agent")
	project := fs.String("project", "", "with --latest: restrict to one project path; also overrides restore directory for project-based sessions")
	host := fs.String("host", "", "with --latest: restrict to sessions pushed from one host")
	latest := fs.Bool("latest", false, "pull the most recently updated session matching the filters")
	projectID := fs.String("project-id", "", "restore every session for this project id into the current directory")
	force := fs.Bool("force", false, "overwrite existing local files")
	dryRun := fs.Bool("dry-run", false, "list archive contents (or, with --skills, the file changes) without writing anything")
	skills := fs.Bool("skills", false, "pull agent configuration (skills, agents, commands, CLAUDE.md) instead of sessions")
	scope := fs.String("scope", "user,project,org", "with --skills: scopes to pull (comma-separated)")
	version := fs.Int("version", 0, "with --skills --name: pull this version of the unit instead of the latest")
	name := fs.String("name", "", "with --skills: pull only this unit (e.g. skills/deploy, commands/fix-tests, CLAUDE.md)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: stift pull <session-id>")
		fmt.Fprintln(os.Stderr, "       stift pull --latest [--agent A] [--project P] [--host H]")
		fmt.Fprintln(os.Stderr, "       stift pull --project-id ID   (restore a whole project here)")
		fmt.Fprintln(os.Stderr, "       stift pull --skills [--scope user,project,org] [--agent A] [--name UNIT [--version N]] [--dry-run] [--force]")
		fs.PrintDefaults()
	}
	fs.Parse(args)

	c, err := client.Require()
	if err != nil {
		return err
	}
	if *skills {
		return pullSkills(c, *agent, *scope, *project, *name, *version, *force, *dryRun)
	}

	if *projectID != "" {
		return reconcileProjectID(c, *projectID, *project)
	}

	var sess api.Session
	switch {
	case fs.NArg() == 1 && !*latest:
		if sess, err = c.Get(fs.Arg(0)); err != nil {
			return err
		}
	case fs.NArg() == 0 && *latest:
		list, err := c.List(client.ListFilter{Agent: *agent, Project: *project, Host: *host})
		if err != nil {
			return err
		}
		if len(list) == 0 {
			return fmt.Errorf("no sessions match the given filters")
		}
		sess = list[0] // server returns newest first
	default:
		fs.Usage()
		os.Exit(2)
	}

	body, err := c.Download(sess.ID)
	if err != nil {
		return err
	}
	defer body.Close()

	if *dryRun {
		return listArchive(body)
	}

	baseDir := ""
	switch sess.Base {
	case "home":
		if baseDir, err = os.UserHomeDir(); err != nil {
			return err
		}
	case "project":
		baseDir = oneOf(*project, sess.Project)
		if baseDir == "" {
			return fmt.Errorf("session restores into a project directory; pass --project")
		}
	default:
		return fmt.Errorf("unknown archive base %q", sess.Base)
	}

	res, err := archive.Unpack(body, baseDir, *force)
	if err != nil {
		return err
	}
	fmt.Printf("restored %s session %s (%s) into %s: %d files extracted",
		sess.Agent, sess.SessionID, oneOf(sess.Title, sess.ID[:8]), baseDir, res.Extracted)
	if len(res.Skipped) > 0 {
		fmt.Printf(", %d existing files skipped (use --force to overwrite)", len(res.Skipped))
	}
	fmt.Println()
	return nil
}

// reconcileProjectID restores every server session for projectID into dir
// (default: the current directory), never overwriting existing files.
func reconcileProjectID(c *client.Client, projectID, dir string) error {
	var err error
	if dir == "" {
		if dir, err = os.Getwd(); err != nil {
			return err
		}
	}
	if dir, err = filepath.Abs(dir); err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	host := resolveHost()
	n, err := daemon.ReconcileOnce(c, home, host, dir, projectID, log.New(os.Stdout, "", 0))
	if err != nil {
		return err
	}
	fmt.Printf("pulled %d session(s) for %s into %s\n", n, projectID, dir)
	return nil
}

func listArchive(r io.Reader) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		fmt.Printf("%10d  %s  %s\n", hdr.Size, hdr.ModTime.Format("2006-01-02 15:04"), filepath.FromSlash(hdr.Name))
	}
}
