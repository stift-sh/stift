import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { Authenticator } from "./authenticator.js";
import { bearer, requireAdmin, type AuthEnv } from "./middleware.js";

const fake: Authenticator = {
  authenticate: async (raw) =>
    raw === "stf_admin" || raw === "stf_user"
      ? { id: "1", tenant: "", name: raw, admin: raw === "stf_admin" }
      : null,
};

const app = new Hono<AuthEnv>()
  .use("/v1/*", bearer(fake))
  .get("/v1/me", (c) => c.json(c.var.identity))
  .get("/v1/admin", requireAdmin, (c) => c.text("ok"));

const get = (path: string, auth?: string) => app.request(path, { headers: auth ? { Authorization: auth } : {} });

test("bearer: missing / malformed / invalid / valid", async () => {
  let r = await get("/v1/me");
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "missing bearer token" });
  r = await get("/v1/me", "Basic abc");
  assert.deepEqual(await r.json(), { error: "missing bearer token" });
  r = await get("/v1/me", "Bearer nope");
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "invalid token" });
  r = await get("/v1/me", "Bearer stf_user");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).name, "stf_user");
});

test("requireAdmin", async () => {
  const r = await get("/v1/admin", "Bearer stf_user");
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: "admin token required" });
  assert.equal((await get("/v1/admin", "Bearer stf_admin")).status, 200);
});
