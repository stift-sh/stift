import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";

test("healthz and version", async () => {
  const app = createApp({ version: "1.2.3" });
  assert.equal(await (await app.request("/healthz")).text(), "ok");
  assert.deepEqual(await (await app.request("/api/version")).json(), { version: "1.2.3", api: 1, features: [] });
  const flagged = createApp({ version: "1.2.3", features: ["cloud"] });
  assert.deepEqual(await (await flagged.request("/api/version")).json(), { version: "1.2.3", api: 1, features: ["cloud"] });
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

test("serves the web bundle with SPA fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stift-web-"));
  await writeFile(join(dir, "index.html"), "<html>shell</html>");
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "assets", "app.js"), "console.log(1)");
  const app = createApp({ version: "1", webDir: dir });

  const asset = await app.request("/assets/app.js");
  assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(await asset.text(), "console.log(1)");

  for (const p of ["/", "/sessions/abc", "/missing.png"]) {
    const r = await app.request(p);
    assert.equal(r.status, 200, p);
    assert.equal(await r.text(), "<html>shell</html>", p);
  }
  assert.equal((await app.request("/../etc/passwd")).status, 200);
  assert.equal(await (await app.request("/api/version")).json().then((v) => v.api), 1);
  assert.equal((await app.request("/v1/nope")).status, 401);
  assert.equal((await app.request("/healthz")).status, 200);
});

test("without a web dir unknown paths 404", async () => {
  const app = createApp({ version: "1" });
  assert.equal((await app.request("/sessions")).status, 404);
});
