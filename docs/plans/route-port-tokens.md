# Route port, step 2a: tokens

First route module of `docs/plans/route-port.md`. Smallest surface, already
has `auth/tokens.ts` underneath, and its test needs a session push to prove
non-admin tokens work, so it also establishes the HTTP test harness the
other modules reuse.

## Routes (`apps/server/src/routes/tokens.ts`)

Mounted under `bearer` and then `requireAdmin` (Go `authed(true, …)`).
`tokens(db)` returns an `OpenAPIHono<AuthEnv>`; all calls are scoped to
`c.var.identity.tenant`.

| Route | Behaviour |
|---|---|
| `GET /v1/tokens` | `listTokens(db, tenant)` → `TokenInfo[]`, 200 |
| `POST /v1/tokens` | body `TokenCreateRequest` (≤ 1 MiB); malformed JSON → 400 `bad request body: <detail>`; empty `name` → 400 `name is required`; `createToken` → 201 `TokenCreated` (`{...info, token}`) |
| `DELETE /v1/tokens/{id}` | `id === identity.id` → 400 `refusing to revoke the token used for this request`; `revokeToken` false → 404 `no such token`; else 204 |

Notes:
- Go decodes the body with `encoding/json`, so unknown fields are accepted
  and `admin` defaults to false. Use `TokenCreateRequest` as the OpenAPI
  schema but parse leniently (`safeParse`, map failure to the 400 above) so
  the wording stays Go-identical rather than zod's.
- 204 responses have no body; declare them in OpenAPI without content.
- Order in `app.ts`: `bearer` → `whoami` → `tokens` (with `requireAdmin` on
  `/v1/tokens/*` and `/v1/tokens`) → later modules.

## Test harness (`apps/server/src/routes/harness.ts`)

Shared by every route test; port of `newTestServer`/`request`/`pushSession`
in `server_test.go`.

- `createTestApp()`: connects with `STIFT_TEST_DATABASE_URL`, runs
  migrations, truncates all tables, builds `PgStore` + `BlobStore` (same env
  as `store.test.ts`, prefix `test`), mints an admin token via `createToken`,
  returns `{ app, admin, db, close }`. Skips the suite when the env var is
  unset, like the store contract suite.
- `req(app, method, path, token, body?, contentType?)` → `Response` via
  `app.request()`.
- `pushSession(app, token, meta, payload)`: builds a multipart body with
  `meta` before `archive`. Until `sessions.ts` lands (step 2b) the token test
  substitutes `GET /v1/whoami` for the "non-admin can use the API" check and
  swaps in `pushSession` once push exists.

## Tests (`apps/server/src/routes/tokens.test.ts`)

Port of `TestTokenLifecycleAndAdminGate` plus the branches Go leaves
untested:

1. admin creates `laptop` → 201, secret non-empty, `admin: false`.
2. that token passes auth (whoami/push) but `POST /v1/tokens` → 403
   `admin token required`.
3. `GET /v1/tokens` as admin lists both.
4. admin revokes it → 204; the revoked token → 401 `invalid token`.
5. revoking own id → 400; unknown id → 404; empty name → 400; bad JSON → 400.
6. `TestAuthRequired` for `/v1/tokens`: no header → 401 `missing bearer
   token`.

## OpenAPI / clients

Tag `tokens`, `security: [{ bearerAuth: [] }]`. After `pnpm build`,
`openapi.gen.json`, `packages/api-client` and `cli/internal/api` change;
commit the regenerated output (`pnpm check:generated` must pass). The CLI
(`cmd_token.go` via `client.TokenCreate/TokenList/TokenRevoke`) stays on its
hand-written calls for now.

## Done when

- `pnpm --filter @stift/server test` green against compose.
- Generated clients committed.
- ADR progress log notes tokens done; next plan: `route-port-sessions.md`.
