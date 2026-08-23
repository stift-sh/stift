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
	case "skills":
		err = cmdSkills(args)
	case "token":
		err = cmdToken(args)
	case "daemon":
		err = cmdDaemon(args)
	case "start":
		err = cmdStart(args)
	case "stop":
		err = cmdStop(args)
	case "restart":
		err = cmdRestart(args)
	case "status":
		err = cmdStatus(args)
	case "link":
		err = cmdLink(args)
	case "unlink":
		err = cmdUnlink(args)
	case "links":
		err = cmdLinks(args)
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

// resolveHost returns this machine's identity for session ownership. It can be
// overridden with STIFT_HOST, useful when the OS hostname is unstable.
func resolveHost() string {
	if h := os.Getenv("STIFT_HOST"); h != "" {
		return h
	}
	h, _ := os.Hostname()
	if h == "" {
		h = "unknown"
	}
	return h
}

func usage() {
	fmt.Print(`stift — self-hosted session store for AI coding agents

Server:
  stift serve [--listen :8580] [--data DIR] [--max-upload-mb N]
      Run the server. Prints an admin token on first start.

Client:
  stift login URL --token TOKEN     Save server connection & start auto-sync
  stift push [flags]                Upload local agent sessions
  stift pull [ID] [flags]           Download and restore sessions
  stift push --skills [flags]       Upload agent config (skills, agents, commands, CLAUDE.md)
  stift pull --skills [flags]       Download agent config; --scope user,project,org
  stift skills list|history NAME|diff NAME [N]|rollback NAME N|delete NAME
                                    Inspect and roll back per-unit config versions
  stift list [flags]                List sessions stored on the server
  stift delete ID...                Delete sessions from the server
  stift agents [flags]              Show sessions detected on this machine
  stift token create|list|revoke    Manage access tokens (admin)

Background sync:
  stift start | stop | restart      Control the background auto-sync service
  stift status                      Show sync status
  stift link [project-id]           Link this project & pull its sessions here
  stift unlink | links              Remove / list project links

Supported agents: claude (Claude Code), codex (Codex CLI), gemini (Gemini CLI),
cursor (Cursor CLI), opencode, aider. Add your own in
~/.config/stift/agents.json — see the Custom agents section of the README.

Environment: STIFT_SERVER, STIFT_TOKEN, STIFT_CONFIG, STIFT_AGENTS, STIFT_SKILLS_STATE,
STIFT_DATA, STIFT_ADMIN_TOKEN (serve), STIFT_SYNC_INTERVAL, STIFT_STATE.

Run "stift COMMAND -h" for command flags.
`)
}
