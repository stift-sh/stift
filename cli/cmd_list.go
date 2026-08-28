package main

import (
	"flag"
	"fmt"
	"os"
	"text/tabwriter"
	"time"

	"github.com/stift-sh/stift/internal/client"
)

func cmdList(args []string) error {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	agent := fs.String("agent", "", "filter by agent")
	project := fs.String("project", "", "filter by exact project path")
	here := fs.Bool("here", false, "filter to sessions for the current directory")
	host := fs.String("host", "", "filter by source host")
	query := fs.String("q", "", "substring search in title, project and session id")
	fs.Parse(args)

	c, err := client.Require()
	if err != nil {
		return err
	}
	proj := *project
	if *here {
		if proj, err = os.Getwd(); err != nil {
			return err
		}
	}
	sessions, err := c.List(client.ListFilter{Agent: *agent, Project: proj, Host: *host, Query: *query})
	if err != nil {
		return err
	}
	if len(sessions) == 0 {
		fmt.Println("no sessions stored")
		return nil
	}
	w := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tAGENT\tHOST\tPROJECT\tTITLE\tFILES\tSIZE\tUPDATED")
	for _, s := range sessions {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%.60s\t%d\t%s\t%s\n",
			s.ID[:8], s.Agent, s.Host, oneOf(s.Project, "-"), oneOf(s.Title, "-"),
			s.Files, humanSize(int64(s.Size)), humanTime(s.UpdatedAt))
	}
	return w.Flush()
}

func cmdDelete(args []string) error {
	fs := flag.NewFlagSet("delete", flag.ExitOnError)
	fs.Usage = func() { fmt.Fprintln(os.Stderr, "usage: stift delete <session-id>...") }
	fs.Parse(args)
	if fs.NArg() == 0 {
		fs.Usage()
		os.Exit(2)
	}
	c, err := client.Require()
	if err != nil {
		return err
	}
	for _, id := range fs.Args() {
		if err := c.Delete(id); err != nil {
			return fmt.Errorf("delete %s: %w", id, err)
		}
		fmt.Printf("deleted %s\n", id)
	}
	return nil
}

func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%cB", float64(n)/float64(div), "KMGTPE"[exp])
}

func humanTime(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 14*24*time.Hour:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	default:
		return t.Local().Format("2006-01-02")
	}
}
