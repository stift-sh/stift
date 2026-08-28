package main

import (
	"flag"
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/stift-sh/stift/internal/api"
	"github.com/stift-sh/stift/internal/client"
)

func cmdUser(args []string) error {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: stift user add|list|role|rm ...")
		os.Exit(2)
	}
	c, err := client.Require()
	if err != nil {
		return err
	}
	switch args[0] {
	case "add":
		fs := flag.NewFlagSet("user add", flag.ExitOnError)
		email := fs.String("email", "", "the member's email (informational)")
		admin := fs.Bool("admin", false, "make the new member an admin")
		noToken := fs.Bool("no-token", false, "do not mint a first token")
		tokenName := fs.String("token-name", "", "name of the first token (default: the user name)")
		fs.Usage = func() {
			fmt.Fprintln(os.Stderr, "usage: stift user add [--email E] [--admin] [--no-token] [--token-name N] <name>")
			fs.PrintDefaults()
		}
		fs.Parse(args[1:])
		if fs.NArg() != 1 {
			fs.Usage()
			os.Exit(2)
		}
		in := api.MemberCreateRequest{Name: fs.Arg(0), Email: *email}
		if *admin {
			in.Role = api.MemberCreateRequestRoleAdmin
		}
		if !*noToken {
			in.Token = *tokenName
			if in.Token == "" {
				in.Token = fs.Arg(0)
			}
		}
		m, err := c.MemberAdd(in)
		if err != nil {
			return err
		}
		fmt.Printf("user %q added as %s (id %s)\n", m.Name, m.Role, m.ID)
		if m.Token != "" {
			server := c.Server()
			fmt.Printf("\nTheir first token, shown once. Hand it over out of band; they connect with:\n\n  stift login %s --token %s\n\n", server, m.Token)
		}
		return nil
	case "list", "ls":
		members, err := c.MemberList()
		if err != nil {
			return err
		}
		w := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tNAME\tROLE\tEMAIL\tTOKENS\tSINCE")
		for _, m := range members {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%d\t%s\n", m.ID, m.Name, m.Role, m.Email, m.Tokens, m.CreatedAt.Local().Format("2006-01-02"))
		}
		return w.Flush()
	case "role":
		if len(args) != 3 || (args[2] != "admin" && args[2] != "member") {
			fmt.Fprintln(os.Stderr, "usage: stift user role <name> admin|member")
			os.Exit(2)
		}
		m, err := c.MemberSetRole(args[1], api.Role(args[2]))
		if err != nil {
			return err
		}
		fmt.Printf("user %q is now %s\n", m.Name, m.Role)
		return nil
	case "rm", "remove", "delete":
		if len(args) != 2 {
			fmt.Fprintln(os.Stderr, "usage: stift user rm <name>")
			os.Exit(2)
		}
		if err := c.MemberRemove(args[1]); err != nil {
			return err
		}
		fmt.Printf("user %q removed (their tokens are revoked)\n", args[1])
		return nil
	default:
		return fmt.Errorf("unknown user subcommand %q (want add, list, role or rm)", args[0])
	}
}
