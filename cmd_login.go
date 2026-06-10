package main

import (
	"bufio"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"

	"stift/internal/client"
)

func cmdLogin(args []string) error {
	fs := flag.NewFlagSet("login", flag.ExitOnError)
	token := fs.String("token", "", "access token (prompted for if omitted)")
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
	role := "token"
	if who.Admin {
		role = "admin token"
	}
	fmt.Printf("logged in to %s as %q (%s); saved to %s\n", server, who.Name, role, path)
	return nil
}
