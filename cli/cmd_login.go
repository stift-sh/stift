package main

import (
	"bufio"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/stift-sh/stift/internal/client"
	"github.com/stift-sh/stift/internal/service"
)

func cmdLogin(args []string) error {
	fs := flag.NewFlagSet("login", flag.ExitOnError)
	token := fs.String("token", "", "access token (prompted for if omitted)")
	noDaemon := fs.Bool("no-daemon", false, "don't start background auto-sync")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: stift login <server-url> [--token TOKEN]")
		fs.PrintDefaults()
	}
	fs.Parse(args)
	if fs.NArg() < 1 {
		fs.Usage()
		os.Exit(2)
	}
	server := strings.TrimRight(fs.Arg(0), "/")
	fs.Parse(fs.Args()[1:]) // allow flags after the URL: login URL --token TOK
	if fs.NArg() != 0 {
		fs.Usage()
		os.Exit(2)
	}
	u, err := url.Parse(server)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return fmt.Errorf("server must be an http(s) URL, got %q", server)
	}

	tok := *token
	if tok == "" {
		fmt.Fprint(os.Stderr, "Token: ")
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil {
			return fmt.Errorf("read token: %w", err)
		}
		tok = strings.TrimSpace(line)
	}
	if tok == "" {
		return fmt.Errorf("no token provided")
	}

	c := client.New(server, tok)
	who, err := c.Whoami()
	if err != nil {
		return fmt.Errorf("could not verify token against %s: %w", server, err)
	}
	path, err := client.SaveConfig(client.Config{Server: server, Token: tok})
	if err != nil {
		return err
	}
	// Older servers only send `admin`; newer ones add role and user.
	role := "token"
	if who.Admin {
		role = "admin token"
	}
	if who.Role != "" {
		role = string(who.Role)
	}
	as := fmt.Sprintf("%q", who.Name)
	if who.User.Name != "" {
		as = fmt.Sprintf("%q (token %q)", who.User.Name, who.Name)
	}
	fmt.Printf("logged in to %s as %s (%s); saved to %s\n", server, as, role, path)

	if !*noDaemon {
		if err := service.Install(); err != nil {
			fmt.Fprintf(os.Stderr, "warning: could not start background sync: %v\n", err)
			fmt.Fprintln(os.Stderr, "retry with `stift start`, or run `stift daemon` in the foreground")
		} else {
			fmt.Println("background auto-sync started — your sessions now sync automatically")
		}
	}
	return nil
}
