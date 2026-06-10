# Stift

Self-hosted cloud storage for AI coding agent sessions.

Your agent sessions — the full conversation history, context, and todo state — live in
scattered dot-directories on whatever machine you happened to be using. **stift**
gives them a home: deploy a single binary (or container) on any server, get a token,
and `stift push` / `stift pull` your sessions between machines.

```
     laptop ──push──▶ ┌───────────────┐ ◀──push── desktop
                      │     stift     │
workstation ◀──pull── │  your server  │ ──pull──▶ new machine
                      └───────────────┘
```

## Supported agents

| Agent | Name | What gets synced |
|---|---|---|
| Claude Code | `claude` | `~/.claude/projects/<project>/<session>.jsonl` + todo state |
| OpenAI Codex CLI | `codex` | `~/.codex/sessions/.../rollout-*.jsonl` |
| Gemini CLI | `gemini` | `~/.gemini/tmp/<project>/` (logs, saved chats, checkpoints) |
| Cursor CLI | `cursor` | `~/.cursor/chats/<project>/<session>/` |
| opencode | `opencode` | session + messages + parts from `~/.local/share/opencode/storage` |
| aider | `aider` | `.aider.chat.history.md`, `.aider.input.history` (in-project) |

One binary, zero runtime dependencies (pure Go stdlib), no database server —
sessions are stored as tar.gz blobs + JSON metadata on disk. The same binary is
both server (`stift serve`) and client (`stift push` / `pull` / ...).

Agents not listed above can be added as [custom agents](#custom-agents) — a
name and a path pattern in a small JSON file.

## Install the client

```sh
curl -fsSL https://stift.sh/install.sh | sh
```

The script detects your OS/arch (linux/darwin, amd64/arm64), verifies the
binary's SHA-256 checksum, and installs to `/usr/local/bin` if writable,
otherwise `~/.local/bin`. Overrides: `STIFT_VERSION` (default `latest`),
`STIFT_INSTALL_DIR`, `STIFT_BASE_URL`. Windows users: download
`stift-windows-amd64.exe` from the releases and put it on `PATH`.

Or build from source with `make build` (Go 1.26+). `make release` produces the
artifacts the install script expects; hosting them just means serving the
`dist/` directory at these paths:

```
https://stift.sh/install.sh                       this script
https://stift.sh/dl/latest/stift-<os>-<arch>      binaries (+ .sha256 each)
https://stift.sh/dl/<version>/stift-<os>-<arch>   pinned versions
```

## Server: deploy in one minute

### Binary

```sh
make build                      # or: go build -o bin/stift .
./bin/stift serve --data /var/lib/stift
```

On first start the server prints an **admin token once** — store it. Then it listens
on `:8580`.

### Docker

```sh
docker compose up -d            # uses docker-compose.yml in this repo
docker compose logs stift   # grab the first-boot admin token
```

Or pin the token instead of fishing it out of logs:

```sh
export STIFT_ADMIN_TOKEN="stf_$(openssl rand -hex 24)"
docker run -d -p 8580:8580 -v stift-data:/data \
  -e STIFT_ADMIN_TOKEN stift:latest
```

A read-only web UI for browsing/downloading sessions is served at `/`
(paste a token; it never leaves your browser).

## Client: push and pull sessions

```sh
# one-time, on each machine
stift login https://sessions.example.com --token stf_...

# see what agents/sessions exist for the current project
stift agents

# push this project's sessions (all agents) to the server
stift push

# ...or be specific
stift push --agent claude,codex --latest
stift push --all-projects              # everything on this machine

# on another machine: browse and restore
stift list
stift pull 1920b89e                    # by id (prefixes work)
stift pull --latest --agent claude     # newest matching session
```

Pushes are idempotent: re-pushing an unchanged session is a no-op (`unchanged`),
a changed session updates the existing record in place (`updated`). Pulls never
overwrite existing local files unless you pass `--force`; `--dry-run` lists the
archive contents first.

Sessions restore to the same project path they came from (agents key their
session storage by project path, so this is what makes the agent see them).

### Custom agents

Any tool that keeps session state in files can be synced. Define it in
`~/.config/stift/agents.json` (override the path with `STIFT_AGENTS`):

```json
[
  { "name": "windsurf", "sessions": "~/.windsurf/runs/*" },
  { "name": "roo",      "sessions": "~/.roo/{md5}/tasks/*" },
  { "name": "notes",    "sessions": ".ai-notes/history.md" }
]
```

Two fields per agent:

- **`name`** — lowercase letters, digits, dashes; must not clash with a
  built-in. Usable everywhere an agent name is (`stift push --agent roo`).
- **`sessions`** — a glob pattern saying where sessions live. Each match
  becomes one session: a matched *file* is a single-file session, a matched
  *directory* is a session containing everything under it. The session id is
  derived from the matched name (`run-7`, `history`, ...).

Pattern rules:

- `~/...` patterns are home-based; anything else resolves against the project
  directory (like aider's in-project history files).
- Many agents encode the project path into a directory name. Placeholders
  cover the common encodings, and make project filtering work exactly like it
  does for built-ins: `{sha256}` (Gemini-style hash), `{md5}` (Cursor-style),
  `{munged}` (Claude-style `-work-app`), `{basename}` (last path element).
- A home-based pattern *without* a placeholder is treated as machine-global:
  it is detected on every push, stored without a project association.

Invalid entries are skipped with a warning; nothing outside your home (or
project) directory is ever archived, even if a pattern tries.

### Tokens

Mint a token per machine/teammate so any one of them can be revoked:

```sh
stift token create laptop          # prints the secret once
stift token create ci --admin     # admin = may manage tokens
stift token list
stift token revoke <id>
```

### Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `STIFT_SERVER`, `STIFT_TOKEN` | client | override saved login (handy for CI) |
| `STIFT_CONFIG` | client | config file path (default `~/.config/stift/config.json`) |
| `STIFT_LISTEN`, `STIFT_DATA` | server | listen address / data directory |
| `STIFT_ADMIN_TOKEN` | server | register a fixed admin token at startup |

## HTTP API

All `/v1` endpoints require `Authorization: Bearer <token>`.

| Method & path | Description |
|---|---|
| `POST /v1/sessions` | upload (multipart: `meta` JSON field, then `archive` tar.gz) |
| `GET /v1/sessions?agent=&project=&host=&q=` | list, newest first |
| `GET /v1/sessions/{id}` | metadata (id prefixes accepted) |
| `GET /v1/sessions/{id}/archive` | download tar.gz |
| `DELETE /v1/sessions/{id}` | delete |
| `GET /v1/whoami` | token name + role |
| `GET/POST/DELETE /v1/tokens` | token management (admin only) |
| `GET /healthz` | liveness (no auth) |

## Security notes

- Tokens are stored **hashed** (SHA-256) on the server; secrets are shown once.
- Run behind TLS — a reverse proxy (Caddy, nginx, Traefik) or your tunnel of
  choice. The server itself speaks plain HTTP.
- Session archives contain full conversation history, which often includes
  source code and may include secrets your agent saw. Treat the data directory
  and tokens accordingly.
- Tar extraction rejects absolute paths and `..` traversal.

## Development

```sh
make test      # unit + API tests
make build     # bin/stift
make release   # cross-compile dist/ for linux/darwin/windows, amd64/arm64
make docker    # build the container image
```

Layout: `internal/agents` (per-agent session detection), `internal/archive`
(tar.gz pack/unpack), `internal/server` (HTTP API + storage + tokens),
`internal/client` (API client + config), `cmd_*.go` (CLI subcommands).

Adding an agent = one file in `internal/agents` implementing
`Detect(home, project) ([]LocalSession, error)` plus a registry entry in
`agents.go`.

## License

MIT
