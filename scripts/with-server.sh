#!/usr/bin/env bash
# Runs a command against a freshly started TypeScript server: resets the
# database, starts apps/server on $PORT, exports STIFT_TEST_SERVER and
# STIFT_TEST_TOKEN for tests that need a live server (Go daemon tests), then
# runs the command. Needs the docker-compose services and a built server.
#
#   ./scripts/with-server.sh sh -c 'cd cli && go test ./internal/daemon'
set -euo pipefail
cd "$(dirname "$0")/.."

export STIFT_DATABASE_URL=${STIFT_DATABASE_URL:-postgres://stift:stift@localhost:5432/stift}
export STIFT_S3_BUCKET=${STIFT_S3_BUCKET:-stift}
export STIFT_S3_ENDPOINT=${STIFT_S3_ENDPOINT:-http://localhost:9000}
export STIFT_S3_ACCESS_KEY=${STIFT_S3_ACCESS_KEY:-stift}
export STIFT_S3_SECRET_KEY=${STIFT_S3_SECRET_KEY:-stiftstift}
export STIFT_S3_FORCE_PATH_STYLE=true
export STIFT_S3_PREFIX=${STIFT_S3_PREFIX:-with-server}
export STIFT_ADMIN_TOKEN=stf_$(printf 'b%.0s' $(seq 48))
export PORT=${PORT:-8582}
export STIFT_WEB_DIR=${STIFT_WEB_DIR:-$PWD/apps/web/dist}

LOG=$(mktemp)
cleanup() { kill "${SERVER_PID:-}" 2>/dev/null || true; rm -f "$LOG"; }
trap cleanup EXIT

(cd apps/server && node --input-type=module -e '
  import pg from "pg";
  const c = new pg.Client({ connectionString: process.env.STIFT_DATABASE_URL });
  await c.connect();
  await c.query("truncate sessions, blobs, bundles, bundle_versions, tokens");
  await c.end();
')

node apps/server/dist/src/main.js >"$LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 50); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null && break
  sleep 0.2
done
curl -sf "http://localhost:$PORT/healthz" >/dev/null || { cat "$LOG"; echo "server did not start"; exit 1; }

export STIFT_TEST_SERVER=http://localhost:$PORT STIFT_TEST_TOKEN=$STIFT_ADMIN_TOKEN
"$@" || { echo "--- server log"; cat "$LOG"; exit 1; }
