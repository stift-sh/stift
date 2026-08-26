package main

import (
	"flag"
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/stift-sh/stift/internal/client"
)

func cmdToken(args []string) error {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: stift token create|list|revoke ...")
		os.Exit(2)
	}
	c, err := client.Require()
	if err != nil {
		return err
	}
	switch args[0] {
	case "create":
		fs := flag.NewFlagSet("token create", flag.ExitOnError)
		admin := fs.Bool("admin", false, "grant admin rights (token management)")
		fs.Usage = func() {
			fmt.Fprintln(os.Stderr, "usage: stift token create <name> [--admin]")
			fs.PrintDefaults()
		}
		fs.Parse(args[1:])
		if fs.NArg() != 1 {
			fs.Usage()
			os.Exit(2)
		}
		created, err := c.TokenCreate(fs.Arg(0), *admin)
		if err != nil {
			return err
		}
		fmt.Printf("token %q created (id %s). The secret is shown once:\n\n  %s\n\n",
			created.Name, created.ID, created.Token)
		return nil
	case "list":
		tokens, err := c.TokenList()
		if err != nil {
			return err
		}
		w := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tNAME\tADMIN\tCREATED\tLAST USED")
		for _, t := range tokens {
			last := "never"
			if t.LastUsedAt != nil {
				last = t.LastUsedAt.Local().Format("2006-01-02 15:04")
			}
			fmt.Fprintf(w, "%s\t%s\t%v\t%s\t%s\n", t.ID, t.Name, t.Admin, t.CreatedAt.Local().Format("2006-01-02 15:04"), last)
		}
		return w.Flush()
	case "revoke":
		if len(args) != 2 {
			fmt.Fprintln(os.Stderr, "usage: stift token revoke <token-id>")
			os.Exit(2)
		}
		if err := c.TokenRevoke(args[1]); err != nil {
			return err
		}
		fmt.Printf("token %s revoked\n", args[1])
		return nil
	default:
		return fmt.Errorf("unknown token subcommand %q (want create, list or revoke)", args[0])
	}
}
