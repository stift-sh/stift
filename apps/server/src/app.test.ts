import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";

test("healthz and version", async () => {
  const app = createApp({ version: "1.2.3" });
  assert.equal(await (await app.request("/healthz")).text(), "ok");
  assert.deepEqual(await (await app.request("/api/version")).json(), { version: "1.2.3", api: 1 });
});
