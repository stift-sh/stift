// Command stift is a self-hosted session store for AI coding agents.
// One binary is both the server (stift serve) and the client
// (stift push / pull / list).
package main

import (
	"fmt"
	"log"
	"os"
)

var version = "0.1.0" // overridden at build time via -ldflags "-X main.version=..."

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "serve":
		err = cmdServe(args)
	case "login":
		err = cmdLogin(args)
	case "push":
		err = cmdPush(args)
	case "pull":
		err = cmdPull(args)
	case "list", "ls":
		err = cmdList(args)
	case "delete", "rm":
		err = cmdDelete(args)
	case "agents", "detect":
		err = cmdAgents(args)
	case "token":
		err = cmdToken(args)
	case "version", "--version", "-v":
		fmt.Println("stift " + version)
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
		usage()
		os.Exit(2)
	}
	if err != nil {
		log.Fatalf("error: %v", err)
	}
}

func usage() {
	fmt.Print(`stift — self-hosted session store for AI coding agents

Server:
  stift serve [--listen :8580] [--data DIR] [--max-upload-mb N]
      Run the server. Prints an admin token on first start.

Client:
  stift login URL --token TOKEN     Save server connection
  stift push [flags]                Upload local agent sessions
  stift pull [ID] [flags]           Download and restore sessions
  stift list [flags]                List sessions stored on the server
  stift delete ID...                Delete sessions from the server
  stift agents [flags]              Show sessions detected on this machine
  stift token create|list|revoke    Manage access tokens (admin)

Supported agents: claude (Claude Code), codex (Codex CLI), gemini (Gemini CLI),
cursor (Cursor CLI), opencode, aider. Add your own in
~/.config/stift/agents.json — see the Custom agents section of the README.

Environment: STIFT_SERVER, STIFT_TOKEN, STIFT_CONFIG, STIFT_AGENTS,
STIFT_DATA, STIFT_ADMIN_TOKEN (serve).

Run "stift COMMAND -h" for command flags.
`)
}
