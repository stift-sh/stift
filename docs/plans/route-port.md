# Route port: Go HTTP server → TS server

Backbone step 1, last port item (ADR 0001 progress log). Port every route in
`cli/engine/server/{server.go,handlers_bundles.go}` to `apps/server`,
byte-compatible so the existing Go CLI (`cli/internal/client/client.go`)
works unchanged, then delete the Go server.

Storage (`Store` in `apps/server/src/storage/store.ts`) and auth
(`bearer`/`requireAdmin`, `auth/tokens.ts`) already exist; this is handler
work plus tests and CI.

## Routes

| Method | Path | Auth | Handler notes |
|---|---|---|---|
| POST | `/v1/sessions` | user | multipart: `meta` JSON part must precede `archive`; validate key/agent/session_id and base ∈ {home, project}; 201 on `created`, 200 otherwise; 413 on `MaxUploadBytes` (200 MiB default) |
| GET | `/v1/sessions` | user | filters `agent`, `project`, `host`, `q` → `store.list` |
| GET | `/v1/sessions/{id}` | user | `resolveId` prefix match; 404 `no such session`, 400 on ambiguous |
| GET | `/v1/sessions/{id}/archive` | user | stream `openArchive`; `Content-Type: application/gzip`, `Content-Disposition: attachment; filename="<agent>-<id>.tar.gz"`, `Last-Modified` from `updated_at` |
| DELETE | `/v1/sessions/{id}` | user | 204 |
| POST | `/v1/blobs/check` | user | `{shas}` ≤ 10000, body ≤ 2 MiB → `{missing: []}` (never null) |
| PUT | `/v1/blobs/{sha}` | user | validate sha; 411 without Content-Length; 413 over `MaxBlobBytes` (5 MiB default); 400 on hash mismatch → `{sha}` |
| GET | `/v1/blobs/{sha}` | user | stream, `application/octet-stream`; 404 `no such blob` |
| GET | `/v1/bundles` | user | filters `scope`, `agent`, `project`, `name`; `[]` never null |
| PUT | `/v1/bundles/{scope}/{agent}/{name...}` | user, admin for `scope=org` | body ≤ 2 MiB; key from path + `?project`; `?force=1`; default `author` to identity name; 409 stale (`stale: current head is version N, bundle parent is M`), 412 missing blob, 400 otherwise; 201 |
| GET | `/v1/bundles/{scope}/{agent}/{name...}` | user | `?history=1` → all versions newest first (404 if no head); `?version=N` non‑negative int else 400; 404 `no such bundle` |
| DELETE | `/v1/bundles/{scope}/{agent}/{name...}` | user, admin for org | 204; 404 |
| GET | `/v1/tokens` | admin | |
| POST | `/v1/tokens` | admin | `{name, admin}`; `name` required; 201 `TokenCreated` |
| DELETE | `/v1/tokens/{id}` | admin | 400 when revoking own token; 404; 204 |

Already ported: `/healthz`, `/v1/whoami`. Not ported: `GET /` web UI
(`web.go`), which is replaced by `apps/web` (sequencing step 2).

Error bodies stay `{"error": "<msg>"}` with the exact Go messages above.
Query‑string semantics (`force=1`, `history=1`) are kept verbatim.

## Layout

```
apps/server/src/routes/
  sessions.ts   # 5 routes
  blobs.ts      # 3 routes
  bundles.ts    # 4 routes
  tokens.ts     # 3 routes, mounted under requireAdmin
  _errors.ts    # shared response schemas + err(c, status, msg) helper
```

Each file exports `sessions(store)` etc. returning an `OpenAPIHono<AuthEnv>`
sub‑app, mounted in `app.ts` after the `bearer` middleware. `createApp` gains
`store?: Store` and `limits?: { maxUploadBytes, maxBlobBytes }` (env
`STIFT_MAX_UPLOAD_BYTES`, `STIFT_MAX_BLOB_BYTES`, defaults as in Go).

## Zod / OpenAPI

Add to `packages/shared`: `PushMeta` (session input), `BlobsCheckRequest`
/`BlobsCheckResponse`, `BlobPutResponse`, `TokenCreateRequest`, and query
schemas for list filters. Binary routes (`archive`, blob get/put, multipart
push) are declared with `application/gzip` / `application/octet-stream` /
`multipart/form-data` content so the generated Go and TS clients keep
matching the CLI's hand‑written calls.

Path catch‑all: Hono supports `/v1/bundles/:scope/:agent/:name{.+}`; confirm
`@hono/zod-openapi` emits it as `{name}` in the spec.

## Streaming and limits

- Push: parse multipart in streaming order (Node `busboy` or Hono's
  `parseBody` is insufficient since it buffers; use `busboy`). Enforce
  `MaxUploadBytes` on the archive part and map overflow to 413 with the Go
  message; abort the S3 upload on overflow.
- Blob put: pass `Content-Length` as `size` to `store.putBlob`; wrap the body
  in a counting stream that rejects past `MaxBlobBytes`.
- Downloads: pipe `Readable` from the store straight to the response
  (`c.body(Readable.toWeb(...))`).

## Tests

1. Port `server_test.go` and `handlers_bundles_test.go` to
   `apps/server/src/routes/*.test.ts` (`node:test`, `app.request()`, real
   Postgres + MinIO from compose like the store contract suite):
   `TestAuthRequired`, `TestPushListDownloadDelete`,
   `TestTokenLifecycleAndAdminGate`, `TestUploadSizeLimit`,
   `TestPushValidation`, `TestBundlePushFlow`,
   `TestBundleStaleAndMissingBlob`, `TestBundleOrgScopeRequiresAdmin`,
   `TestBlobValidation`. `TestStoreSurvivesRestart` is covered by Postgres and
   is dropped.
2. Golden compat: a small table of request → expected status + body strings
   taken from the Go server, asserted on both servers while both exist.
3. CI smoke job (`.github/workflows/ci.yml`): start compose, run the TS
   server, build the CLI, then `stift login`, `stift push`, `stift list`,
   `stift pull`, `stift skills push/pull` against it.

## Delete the Go server

`cli/engine/server` is imported by `cli/cmd_serve.go` (`stift serve`) and
`cli/internal/daemon/skills_test.go`. After the smoke job is green:

- remove `stift serve` (self‑host is `docker compose up` per ADR decision 5);
- point `skills_test.go` at an in‑process TS server or at the compose
  service in CI;
- delete `cli/engine/server` and `web.go`; keep `cli/engine/api/types.go`
  until `cli/internal/api` (generated) replaces its remaining uses.

## Order

1. `_errors.ts`, shared schemas, `createApp` wiring, limits config.
2. tokens → sessions → blobs → bundles, each with its ported tests.
3. Golden compat table, CLI smoke job.
4. Go server deletion, ADR progress log tick.
