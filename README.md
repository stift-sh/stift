# Stift

Self-hosted cloud storage for AI coding agent sessions.

Your agent sessions — the full conversation history, context, and todo state — live in
scattered dot-directories on whatever machine you happened to be using. **stift**
gives them a home: run the server (one container, Postgres, an S3 bucket), get a token,
and log in once. After that a small background service **syncs your sessions
automatically** — no manual push/pull. `stift push` / `stift pull` are still there
when you want explicit control.

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

The client is one static Go binary with zero runtime dependencies. The server
is a TypeScript service shipped as a container image; it keeps metadata in
Postgres and session archives / skill files as content-addressed blobs in any
S3-compatible bucket (S3, R2, MinIO).

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

Binaries come from [GitHub releases](https://github.com/stift-sh/stift/releases)
(`stift-<os>-<arch>` plus a `.sha256` each, built by GoReleaser on every `v*`
tag). Or build from source with `make build` (Go 1.26+).

The web app lives in [`apps/web/`](apps/web/) (Vite + React, talking to the
server only through the generated `@stift/api-client`); the server image serves
its build at `/`. For development run `docker compose up -d` and `pnpm dev` in
`apps/web`, which proxies `/v1` and `/api` to `:8580`.

The stift.sh site lives in [`apps/website/`](apps/website/) — a Cloudflare
Worker serving the docs page and the installer as static assets
(`make site-deploy`).

## Background sync

`stift login` also starts a small background service, so you set up a machine
once and then forget about it — sessions sync on their own.

```sh
# one-time, on each machine — logs in AND starts background auto-sync
stift login https://sessions.example.com --token stf_...
```

From then on a lightweight daemon (a per-user systemd/launchd service, or a
detached process where neither exists) runs every ~30s and:

- **pushes** every changed agent session across *all* your projects, and
- **pulls** sessions for projects you're actively working on here, restoring
  them so the local agent sees them — **never overwriting a live local file**
  (conflicts are logged, not applied), and
- **syncs skills and agent config** (see [Skills](#skills-and-agent-configuration)):
  units in user scope and in every project seen here are pushed once they have
  been unchanged for 2 minutes (`STIFT_SKILLS_DEBOUNCE`), so half-edited skills
  are not published; newer server versions are pulled when your local copy is
  untouched since the last sync, and org units are always applied and linked.
  A unit that changed on both sides is logged once and left alone — resolve
  with `stift pull --skills` / `stift push --skills`; the daemon never forces.
  Set `STIFT_SYNC_SKILLS=0` to sync sessions only.

On a second machine, point stift at a folder and it pulls that project's history
right away; later sessions keep syncing automatically:

```sh
cd ~/code/myapp
stift link                 # pulls this project's sessions now
```

Projects are matched across machines by **git repo name** — the remote's last
path segment, or the folder name when there's no remote — so the same repo lines
up even when its path differs from machine to machine.

```sh
stift start | stop | restart    # control the background service
stift status                    # running state + sessions on the server not here yet
stift link | unlink | links     # manage which folders pull which project
stift pull --project-id NAME    # restore a whole project into the current dir
stift login --no-daemon ...     # log in without starting background sync
```

Everything below still works by hand — you just shouldn't need it day to day.

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

### Skills and agent configuration

Besides sessions, stift syncs the files that *configure* an agent — skills,
subagents, slash commands and `CLAUDE.md`. Each of these is a **unit** with
its own version history, so rolling back one skill never touches its
neighbours:

| Unit name | What it is (Claude Code, user scope) |
|---|---|
| `skills/<name>` | the directory `~/.claude/skills/<name>/` (SKILL.md and everything beside it) |
| `agents/<name>` | `~/.claude/agents/<name>.md` (or a directory of that name) |
| `commands/<name>` | `~/.claude/commands/<name>.md` (or a directory of that name) |
| `CLAUDE.md` | `~/.claude/CLAUDE.md` |

Project scope names are relative to the project directory: `.claude/skills/<name>`,
`.claude/commands/<name>`, `.claude/CLAUDE.md` and the top-level `CLAUDE.md`.

```sh
stift push --skills                    # every unit in user (~/.claude) + project scope
stift push --skills --scope user       # one scope only; org requires the admin role
stift push --skills --name skills/deploy
stift pull --skills                    # user + project + org, newest version of each unit
stift pull --skills --dry-run          # show what would change
stift pull --skills --name skills/deploy --version 3
stift skills list                      # units on the server, with parsed skill names
stift skills history skills/deploy
stift skills diff skills/deploy [N]    # local files vs server version N (default: latest)
stift skills rollback skills/deploy N  # re-publish version N as the newest version
stift skills delete skills/deploy      # remove the unit and its history from the server
```

`settings*.json`, `.mcp.json`, env files, dotfiles, symlinks and files over
5 MB are never included (hooks and MCP configs hold secrets and run code).
Loose non-markdown files directly under `skills/`, `agents/` or `commands/`
are not units and are skipped.

Every push creates a new version of each changed unit whose parent is the
version you last synced (tracked per unit in `~/.config/stift/state.json`,
override with `STIFT_SKILLS_STATE`). If someone else pushed that unit in between,
the push is rejected as stale: run `stift pull --skills` to take their
changes first, or `--force` to overwrite. Pulls write files atomically and
never overwrite a file you changed locally since the last sync unless you
pass `--force`; files (and whole units) deleted on the server are deleted
locally only if you had not modified them. A unit you delete locally stays
on the server until you `stift skills delete` it.

**Org scope** is written by admins and pulled by everyone
(`stift pull --skills --scope org`). Org units are mirrored into
`~/.stift/org/<agent>/` and each one is symlinked into the agent's own
directory (`~/.claude/skills/<name>`, `~/.claude/commands/<name>.md`, ...),
so org and personal config never collide and removing an org unit removes
the link. An existing entry that is not one of these links is left untouched
with a warning; top-level org units such as `CLAUDE.md` stay in the mirror
directory and are reported rather than merged.

A subscription follows the org: the next pull brings the next version. To
edit an org skill for yourself, install it instead, which makes a detached
copy in the agent's own directory and remembers the version it came from:

```sh
stift skills install skills/policy             # copy the org unit into ~/.claude/skills/policy
stift skills install skills/policy --replace   # turn an existing subscription into a copy
stift skills outdated                          # installs that are behind the org's newest version
stift skills install skills/policy --upgrade   # re-copy the newest version (--force: over local edits)
```

Pulls and installs of org units are reported to the server, so admins see
who has which version on the skill's page in the web app (*Pulls*).

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

An optional **`config`** field makes `--skills` work for a custom agent too:

```json
{ "name": "myagent", "sessions": "~/.myagent/runs/*",
  "config": { "user": ["~/.myagent/skills/**", "~/.myagent/rules.md"],
              "project": [".myagent/**", "AGENTS.md"] } }
```

`user` patterns must start with `~/`, `project` patterns are project-relative
and the default exclusions above apply. Units are derived from the patterns:
a literal path is one unit, `<dir>/**` makes each entry directly under
`<dir>` a unit (markdown files drop their `.md` in the name), and any other
glob makes each match a unit named by its path relative to home or the
project. Names may be at most three path segments deep.

### Users, roles and tokens

A server has one org; every user is an `admin` or a `member`. Tokens belong
to a user and carry its role, so changing a role applies to all of that
user's tokens at once.

| | member | admin |
|---|---|---|
| read sessions, skills and members of the org | yes | yes |
| write project-scope units and their own user-scope units | yes | yes |
| write org-scope units, or another user's user-scope units | no | yes |
| delete sessions | their own | any |
| manage tokens | their own | the org's |
| add and remove users, change roles | no | yes |

The first admin is `env-admin` when `STIFT_ADMIN_TOKEN` is set (changing the
variable adds a second token for the same user, the old one keeps working
until you revoke it), otherwise `admin`, whose token is printed once on
first start. The server refuses to demote or remove the last admin. The
same screens are in the web app under *Members* and *Tokens*.

```sh
stift user add --email a@b.co alice   # admin: creates the user and prints a first token once
stift user list
stift user role alice admin           # or member; applies to all her tokens at once
stift user rm alice                   # revokes her tokens too

stift token create laptop             # a token for yourself; prints the secret once
stift token create --user alice ci    # admin: a token for another member
stift token list                      # admins see the org, members their own
stift token revoke <id>
```

### Limits

A self-hosted org is unlimited by default. Three variables cap it:

| Variable | Limits |
|---|---|
| `STIFT_MAX_SKILLS` | config units (skills, agents, commands, CLAUDE.md) across all scopes |
| `STIFT_MAX_STORAGE_BYTES` | bytes of unit file content; session archives are not counted |
| `STIFT_MAX_SEATS` | users in the org |

Each takes a positive integer, or `unlimited` to clear a limit set earlier;
they are written to the org at startup, and a variable you leave unset
leaves its limit as it is. A write that would exceed a limit is refused with
`402` and a message such as `limit: 50 skills per org`, which the CLI prints
and the web app shows inline. Lowering a limit below current usage removes
nothing, it only blocks growth. `GET /v1/org` and the org card in the web
app show limits next to current usage.

### Public registry

Every stift server is a registry. An admin sets the org slug (`STIFT_ORG_SLUG`,
`PATCH /v1/org` or the org card), then publishes an org-scope skill as
`@<slug>/<name>`; the slug is locked once anything is published.

```sh
stift skills publish skills/deploy --license MIT       # admin: @acme/deploy v1 (--name, --version N)
stift skills publish skills/deploy                     # after an edit + push: v2
stift skills unpublish @acme/deploy@2                  # hide one version (or the skill: @acme/deploy)
stift skills restore @acme/deploy@2                    # visible again
stift skills search deploy --registry https://stift.example.com
```

The same actions live on the skill's page in the web app (*Published*), with
the install command ready to copy. Anyone can then resolve a published skill
and fetch its files **without a token**, from the CLI or with plain HTTP:

```sh
stift skills install @acme/deploy --registry https://stift.example.com   # no stift login needed
stift skills install @acme/deploy@1 --agent cursor                       # pin a version, pick the agent
stift skills outdated                                                    # also checks registry installs
curl https://stift.example.com/v1/registry/skills/@acme/deploy           # latest visible version
curl https://stift.example.com/v1/registry/skills/@acme/deploy/2         # a numbered version, immutable
curl https://stift.example.com/v1/registry/skills?q=deploy               # search
```

Versions are a publish sequence (1, 2, 3…), independent of the org unit's own
history; each records the source version it was copied from. Publishing
copies the manifest, so editing, rolling back or deleting the org unit never
changes what was published, and publishing identical files again is refused.
Unpublishing hides a version (or the skill) from search and `latest`; it
still resolves by number so existing installs keep verifying, and `outdated`
says `unpublished`. Only files listed in a published version's manifest are
reachable through the registry; the org's other blobs stay behind the token.
Nothing is exposed until an admin publishes, and `STIFT_REGISTRY=off`
disables the routes and publishing altogether. The server does not rate-limit
these routes; do that in your reverse proxy.

**Which registry the CLI asks**, in order: `--registry`, `STIFT_REGISTRY_URL`,
`registry` in `~/.config/stift/config.json`, the server you are logged in to
when it advertises the `registry` feature, then `https://app.stift.sh`. A miss
names the registry it asked. Registry installs are plain directories under
the agent (`~/.claude/skills/deploy`), verified blob by blob against the
published manifest, and are never reported to any server. A registry install
and an org install of the same unit cannot share the directory; `--force`
replaces one with the other.

### Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `STIFT_SERVER`, `STIFT_TOKEN` | client | override saved login (handy for CI) |
| `STIFT_CONFIG` | client | config file path (default `~/.config/stift/config.json`) |
| `STIFT_SYNC_INTERVAL` | daemon | background sync interval (default `30s`) |
| `STIFT_SYNC_SKILLS` | daemon | `0` disables skills/agent-config sync in the daemon |
| `STIFT_SKILLS_DEBOUNCE` | daemon | how long a unit must be unchanged before the daemon pushes it (default `2m`) |
| `STIFT_HOST` | client/daemon | override this machine's host label (default OS hostname) |
| `STIFT_STATE` | daemon | sync-state cache path (default `~/.cache/stift/sync-state.json`) |
| `STIFT_SKILLS_STATE` | client | skills sync state (default `~/.config/stift/state.json`) |
| `PORT` | server | listen port (default `8580`) |
| `STIFT_ADMIN_TOKEN` | server | register a fixed admin token at startup (user `env-admin`) |
| `STIFT_ORG_NAME` | server | display name of the org (default `Default`); applied while the org still has the default name, so a rename is not overwritten |
| `STIFT_ORG_SLUG` | server | slug of the org (default `default`): 2-39 lowercase letters, digits or hyphens. Applied while the slug is still `default`; admins change it later with `PATCH /v1/org` or on the org card |
| `STIFT_DATABASE_URL` | server | Postgres connection string (required) |
| `STIFT_S3_BUCKET`, `STIFT_S3_ENDPOINT`, `STIFT_S3_REGION`, `STIFT_S3_ACCESS_KEY`, `STIFT_S3_SECRET_KEY`, `STIFT_S3_FORCE_PATH_STYLE`, `STIFT_S3_PREFIX` | server | blob storage (any S3-compatible API) |
| `STIFT_MAX_SKILLS`, `STIFT_MAX_STORAGE_BYTES`, `STIFT_MAX_SEATS` | server | limits of the default org, applied at startup: a positive integer, or `unlimited` to clear one (default: unlimited). Writes over a limit get `402`; `GET /v1/org` shows limits and usage |
| `STIFT_AUTH` | server | comma-separated authenticators (default `local`) |
| `STIFT_FEATURES` | server | comma-separated feature flags advertised on `/api/version` (e.g. `cloud`); the web app shows matching screens only |
| `STIFT_REGISTRY_URL` | client | registry for `stift skills install @org/name` and `search` when `--registry` is not given; see *Public registry* for the full order |
| `STIFT_REGISTRY` | server | `public` (default) serves the unauthenticated registry under `/v1/registry` and advertises feature `registry`; `off` 404s those routes and refuses `POST /v1/published` |
| `STIFT_WEB_DIR` | server | directory of the built web app to serve at `/` (default `apps/web/dist`, `/app/web` in the image); absent → API only |

## Server: deploy in one minute

The server is published as `ghcr.io/stift-sh/stift` (tags: `latest`, `x.y.z`,
`x.y`). It needs a Postgres database and an S3-compatible bucket.

### Docker Compose (everything included)

```sh
curl -fsSLO https://raw.githubusercontent.com/stift-sh/stift/main/docker-compose.yml
docker compose up -d
docker compose logs server      # grab the first-boot admin token
```

This runs Postgres and MinIO next to the server with persistent volumes. On
first start the server prints an **admin token once** — store it. Then it
listens on `:8580`, ready for `stift login http://<host>:8580 --token stf_...`.

### Your own database and bucket

Point the image at whatever you already run (RDS + S3, Neon + R2, ...):

```sh
export STIFT_ADMIN_TOKEN="stf_$(openssl rand -hex 24)"   # optional: pin the token
docker run -d -p 8580:8580 \
  -e STIFT_DATABASE_URL=postgres://user:pass@db:5432/stift \
  -e STIFT_S3_BUCKET=stift -e STIFT_S3_REGION=us-east-1 \
  -e STIFT_S3_ACCESS_KEY=... -e STIFT_S3_SECRET_KEY=... \
  -e STIFT_ADMIN_TOKEN \
  ghcr.io/stift-sh/stift:latest
```

Set `STIFT_S3_ENDPOINT` (and `STIFT_S3_FORCE_PATH_STYLE=true`) for non-AWS
providers. Migrations run automatically at startup. Put TLS in front with your
usual reverse proxy; the server itself speaks plain HTTP.

## HTTP API

All `/v1` endpoints require `Authorization: Bearer <token>`, except the
read-only `/v1/registry` routes.

| Method & path | Description |
|---|---|
| `POST /v1/sessions` | upload (multipart: `meta` JSON field, then `archive` tar.gz) |
| `GET /v1/sessions?agent=&project=&host=&q=` | list, newest first |
| `GET /v1/sessions/{id}` | metadata (id prefixes accepted) |
| `GET /v1/sessions/{id}/archive` | download tar.gz |
| `DELETE /v1/sessions/{id}` | delete |
| `POST /v1/blobs/check` | body `{"shas":[...]}` → `{"missing":[...]}` (max 10k) |
| `PUT /v1/blobs/{sha}` | upload raw content by sha256 (`Content-Length` required, ≤ 5 MB); 400 on hash mismatch |
| `GET /v1/blobs/{sha}` | download raw blob |
| `GET /v1/bundles?scope=&agent=&project=&name=` | list HEAD manifests of config units (one bundle per skill, agent, command, CLAUDE.md) |
| `PUT /v1/bundles/{scope}/{agent}/{name}?project=&force=1` | publish a manifest for unit `name` (1–3 path segments; body: bundle JSON with unit-relative file paths); 409 stale, 412 blobs missing, org scope admin-only |
| `GET /v1/bundles/{scope}/{agent}/{name}?project=&version=` | manifest (HEAD unless `version`) |
| `GET /v1/bundles/{scope}/{agent}/{name}?project=&history=1` | all versions of the unit, newest first |
| `DELETE /v1/bundles/{scope}/{agent}/{name}?project=` | delete the unit and its history (org scope admin-only) |
| `GET /v1/whoami` | token name, user, role and org |
| `GET/POST/DELETE /v1/tokens` | own tokens, each with the `role` of its user; admins see the org and may `POST` with `user` for another member |
| `GET /v1/members` | members of the org with role and token count |
| `POST /v1/members` | admin: add a user (`name`, `email`, `role`, optional `token` name mints a first token, shown once) |
| `PATCH /v1/members/{id}` | admin: change `role` (id or name); refuses to demote the last admin |
| `DELETE /v1/members/{id}` | admin: remove a member and their tokens; refuses self |
| `GET /v1/org` | the org with its limits and current usage |
| `GET/POST /v1/installs` | where org units are pulled or installed, per user, agent, unit and host |
| `GET /v1/published` | the org's published skills with every version, hidden ones included |
| `POST /v1/published` | admin: publish an org-scope skill as `@<slug>/<name>` (`agent`, `unit`, optional `name`, `license` (required the first time), source `version`); 409 when the same files are already published |
| `DELETE /v1/published/{name}?version=` | admin: hide a version, or the whole skill; `POST /v1/published/{name}/restore?version=` undoes it |
| `GET /v1/registry/skills?q=&limit=&cursor=` | **no auth**: search visible published skills, newest first |
| `GET /v1/registry/skills/@{org}/{name}[/{version}]` | **no auth**: the skill and its latest visible version, or the numbered one (hidden versions still resolve, with `unpublished_at` set) |
| `GET /v1/registry/skills/@{org}/{name}/{version}/blobs/{sha}` | **no auth**: a file of that version; 404 unless the sha is in its manifest |
| `GET /healthz` | liveness (no auth) |

## Security notes

- Tokens are stored **hashed** (SHA-256) on the server; secrets are shown once.
- Run behind TLS — a reverse proxy (Caddy, nginx, Traefik) or your tunnel of
  choice. The server itself speaks plain HTTP.
- Session archives contain full conversation history, which often includes
  source code and may include secrets your agent saw. Treat the database, the bucket
  and tokens accordingly.
- Tar extraction rejects absolute paths and `..` traversal.

## Development

```sh
docker compose up -d postgres minio minio-init   # backing services
pnpm install && pnpm build                        # server, generated clients, CLI
pnpm test                                         # TS tests + Go unit tests
./scripts/with-server.sh sh -c 'cd cli && go test ./internal/daemon'  # Go tests needing a server
./scripts/cli-smoke.sh                            # Go CLI end-to-end against the TS server
make docker                                       # build the server image locally
make release                                      # GoReleaser snapshot of the CLI into cli/dist/
```

Turborepo monorepo: `apps/server` (Hono + zod-openapi on Node, drizzle on
Postgres, S3 blob store), `packages/shared` (zod schemas, the API's source of
truth), `packages/api-client` (generated TypeScript client), `cli/` (Go).
`apps/server` emits `openapi.gen.json` at build; the TS client and
`cli/internal/api` regenerate from it and CI fails if they are stale.

CLI layout: `internal/agents` (per-agent session detection), `engine/archive`
(tar.gz pack/unpack), `internal/client` (API client + config), `internal/daemon`
(background push + reconcile loop), `internal/service`
(systemd/launchd/detached-process control), `internal/gitrepo` (cross-machine
project identity), `cmd_*.go` (CLI subcommands).

Adding an agent = one file in `internal/agents` implementing
`Detect(home, project) ([]LocalSession, error)` plus a registry entry in
`agents.go`.

Releases: tag `vX.Y.Z`; the release workflow runs GoReleaser for the CLI and
pushes the multi-arch server image to GHCR with matching tags.

## License

MIT
