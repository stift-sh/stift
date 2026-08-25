import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";

test("healthz and version", async () => {
  const app = createApp({ version: "1.2.3" });
  assert.equal(await (await app.request("/healthz")).text(), "ok");
  assert.deepEqual(await (await app.request("/api/version")).json(), { version: "1.2.3", api: 1 });
});

test("whoami requires a bearer token", async () => {
  const app = createApp({
    version: "1",
    auth: { authenticate: async (raw) => (raw === "stf_ok" ? { id: "1", tenant: "", name: "me", admin: true } : null) },
  });
  assert.equal((await app.request("/v1/whoami")).status, 401);
  const r = await app.request("/v1/whoami", { headers: { Authorization: "Bearer stf_ok" } });
  assert.deepEqual(await r.json(), { name: "me", admin: true });
});
