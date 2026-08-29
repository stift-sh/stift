#!/usr/bin/env bash
# CLI smoke test: drives the Go CLI against the TypeScript server so the
# route port stays byte-compatible. Needs the docker-compose services
# (postgres + minio) and a built CLI at cli/bin/stift.
set -euo pipefail
cd "$(dirname "$0")/.."

export STIFT_DATABASE_URL=${STIFT_DATABASE_URL:-postgres://stift:stift@localhost:5432/stift}
export STIFT_S3_BUCKET=${STIFT_S3_BUCKET:-stift}
export STIFT_S3_ENDPOINT=${STIFT_S3_ENDPOINT:-http://localhost:9000}
export STIFT_S3_ACCESS_KEY=${STIFT_S3_ACCESS_KEY:-stift}
export STIFT_S3_SECRET_KEY=${STIFT_S3_SECRET_KEY:-stiftstift}
export STIFT_S3_FORCE_PATH_STYLE=true
export STIFT_S3_PREFIX=smoke
export STIFT_ADMIN_TOKEN=stf_$(printf 'a%.0s' $(seq 48))
export PORT=${PORT:-8581}

WORK=$(mktemp -d)
STIFT=$PWD/cli/bin/stift
cleanup() { "$STIFT" stop >/dev/null 2>&1 || true; kill "${SERVER_PID:-}" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { echo "FAIL: $*"; cat "$WORK/server.log" 2>/dev/null; exit 1; }

# Start from an empty database, like a fresh data dir in the Go tests.
(cd apps/server && node --input-type=module -e '
  import pg from "pg";
  const c = new pg.Client({ connectionString: process.env.STIFT_DATABASE_URL });
  await c.connect();
  await c.query("truncate sessions, blobs, bundles, bundle_versions, tokens, installs, memberships, users cascade");
  await c.end();
') || fail "reset database"

node apps/server/dist/src/main.js >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 50); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null && break
  sleep 0.2
done
curl -sf "http://localhost:$PORT/healthz" >/dev/null || { cat "$WORK/server.log"; echo "server did not start"; exit 1; }

export HOME=$WORK/home STIFT_CONFIG=$WORK/config.json STIFT_STATE=$WORK/state STIFT_SKILLS_STATE=$WORK/skills-state
mkdir -p "$HOME"

# login + tokens (roles, tenant rule)
OUT=$("$STIFT" login "http://localhost:$PORT" --token "$STIFT_ADMIN_TOKEN")
echo "$OUT" | grep -q "(admin)" || fail "login as admin: $OUT"
"$STIFT" stop >/dev/null 2>&1 || true # login starts the background sync; the smoke drives pushes itself
"$STIFT" token list | grep -q admin || fail "token list"
"$STIFT" token create laptop | grep -q 'stf_' || fail "token create"

# A member of the org, added through the members API. The first token is
# printed once in a ready-made login line.
OUT=$("$STIFT" user add --email dev@example.com --token-name dev-laptop dev)
echo "$OUT" | grep -q 'added as member' || fail "user add: $OUT"
USER_TOKEN=$(echo "$OUT" | grep -o 'stf_[0-9a-f]*')
[ -n "$USER_TOKEN" ] || fail "user add printed no token"
"$STIFT" user list | grep -q 'dev.*member.*dev@example.com' || fail "user list"
OUT=$("$STIFT" user add dev 2>&1 || true)
echo "$OUT" | grep -q 'already exists' || fail "duplicate user: $OUT"
OUT=$(STIFT_TOKEN=$USER_TOKEN "$STIFT" user add eve 2>&1 || true)
echo "$OUT" | grep -q 'admin token required' || fail "member user add: $OUT"
STIFT_TOKEN=$USER_TOKEN "$STIFT" user list | grep -q admin || fail "member user list"
"$STIFT" token create --user dev dev-phone | grep -q 'created for dev' || fail "token create --user"
"$STIFT" user role dev admin | grep -q 'now admin' || fail "user role admin"
STIFT_TOKEN=$USER_TOKEN "$STIFT" token list | grep -q 'true' || fail "promoted member token has admin role"
"$STIFT" user role dev member | grep -q 'now member' || fail "user role member"
OUT=$("$STIFT" user role env-admin member 2>&1 || true)
echo "$OUT" | grep -q 'last admin' || fail "last admin guard: $OUT"
OUT=$(STIFT_TOKEN=$USER_TOKEN "$STIFT" token create --admin x 2>&1 || true)
echo "$OUT" | grep -q "admin token required" || fail "member --admin: $OUT"
STIFT_TOKEN=$USER_TOKEN "$STIFT" token list | grep -q dev-laptop || fail "member token list"
STIFT_TOKEN=$USER_TOKEN "$STIFT" token list | grep -q laptop$ && fail "member sees admin tokens"
"$STIFT" token list | grep -q dev-laptop || fail "admin sees member tokens"

# sessions: a custom agent with one file session
mkdir -p "$HOME/.smoke/runs/run-1" "$WORK/project"
echo "hello session" >"$HOME/.smoke/runs/run-1/log.txt"
echo '[{"name":"smoke","sessions":"~/.smoke/runs/*"}]' >"$WORK/agents.json"
export STIFT_AGENTS=$WORK/agents.json
(cd "$WORK/project" && "$STIFT" push --agent smoke --all-projects) | grep -q "^created" || fail "push not created"
"$STIFT" list --agent smoke | grep -q smoke || fail "list"
(cd "$WORK/project" && "$STIFT" push --agent smoke --all-projects) | grep -qi unchanged || fail "re-push not unchanged"
rm -rf "$HOME/.smoke/runs/run-1"
"$STIFT" pull --latest --agent smoke --force || fail "pull"
grep -q "hello session" "$HOME/.smoke/runs/run-1/log.txt" || fail "pulled content"
ID=$("$STIFT" list --agent smoke | awk 'NR==2{print $1}')
"$STIFT" delete "$ID" || fail "delete"
"$STIFT" list --agent smoke | grep -q smoke && fail "still listed after delete"

# skills: blobs + bundles round trip, history, org gate
mkdir -p "$HOME/.claude/skills/hello"
printf -- '---\nname: hello\ndescription: says hi\n---\n# Hello\n' >"$HOME/.claude/skills/hello/SKILL.md"
echo "# CLAUDE.md" >"$HOME/.claude/CLAUDE.md"
"$STIFT" push --skills --scope user || fail "skills push"
"$STIFT" skills list --scope user | grep -q "skills/hello" || fail "skills list"
echo "more" >>"$HOME/.claude/skills/hello/SKILL.md"
"$STIFT" push --skills --scope user --name skills/hello || fail "skills push v2"
"$STIFT" skills history skills/hello --scope user | grep -q "2" || fail "history"
rm -rf "$HOME/.claude/skills"
"$STIFT" pull --skills --scope user --force || fail "skills pull"
grep -q more "$HOME/.claude/skills/hello/SKILL.md" || fail "pulled skill content"
"$STIFT" pull --skills --scope user --name skills/hello --version 1 --force || fail "pull v1"
grep -q more "$HOME/.claude/skills/hello/SKILL.md" && fail "v1 should not contain v2 edit"
mkdir -p "$HOME/.stift/org/claude/skills/policy"
printf -- '---\nname: policy\ndescription: org rules\n---\n' >"$HOME/.stift/org/claude/skills/policy/SKILL.md"
OUT=$(STIFT_TOKEN=$USER_TOKEN "$STIFT" push --skills --scope org 2>&1 || true)
echo "$OUT" | grep -q "org scope requires an admin token" || fail "org gate (non-admin): $OUT"
"$STIFT" push --skills --scope org || fail "org push (admin)"
"$STIFT" skills list --scope org | grep -q "skills/policy" || fail "org list"
# install with provenance: subscribe first (reported), then fork with --replace, then outdated
STIFT_TOKEN=$USER_TOKEN "$STIFT" pull --skills --scope org || fail "org pull (member)"
[ -L "$HOME/.claude/skills/policy" ] || fail "org pull should symlink"
OUT=$(STIFT_TOKEN=$USER_TOKEN "$STIFT" skills install skills/policy 2>&1 || true)
echo "$OUT" | grep -q "already subscribed" || fail "install should refuse a subscription: $OUT"
STIFT_TOKEN=$USER_TOKEN "$STIFT" skills install skills/policy --replace || fail "install --replace"
[ -d "$HOME/.claude/skills/policy" ] && [ ! -L "$HOME/.claude/skills/policy" ] || fail "install should be a real directory"
STIFT_TOKEN=$USER_TOKEN "$STIFT" skills outdated | grep -q "up to date" || fail "outdated (up to date)"
echo "stricter" >>"$HOME/.stift/org/claude/skills/policy/SKILL.md"
"$STIFT" push --skills --scope org || fail "org push v2"
OUT=$(STIFT_TOKEN=$USER_TOKEN "$STIFT" skills outdated 2>&1 || true)
echo "$OUT" | grep -q "behind" || fail "outdated (behind): $OUT"
STIFT_TOKEN=$USER_TOKEN "$STIFT" skills install skills/policy --upgrade || fail "install --upgrade"
grep -q stricter "$HOME/.claude/skills/policy/SKILL.md" || fail "upgraded content"
curl -sf -H "Authorization: Bearer $STIFT_ADMIN_TOKEN" "http://localhost:$PORT/v1/installs?name=skills/policy" | grep -q '"from":"install"' || fail "install reported"
curl -sf -H "Authorization: Bearer $STIFT_ADMIN_TOKEN" "http://localhost:$PORT/v1/installs?name=skills/policy" | grep -q '"version":2' || fail "install version reported"
"$STIFT" skills delete skills/hello --scope user || fail "skills delete"

echo "cli smoke: ok"
