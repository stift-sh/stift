import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Install } from "@stift/shared";
import { createTestApp, req, resetDb, skip, type TestApp } from "./harness.js";

describe("installs routes", { skip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp();
  });
  beforeEach(() => resetDb(t.db));
  after(() => t.close());

  const post = (token: string, body: unknown) => req(t.app, "POST", "/v1/installs", token, JSON.stringify(body), "application/json");
  const report = { agent: "claude", name: "skills/deploy", version: 3, host: "laptop", from: "install" };

  test("auth required", async () => {
    assert.equal((await req(t.app, "GET", "/v1/installs")).status, 401);
    assert.equal((await post("", report)).status, 401);
  });

  test("members report and read; a re-report of the same host upserts", async () => {
    assert.equal((await post(t.member, report)).status, 204);
    assert.equal((await post(t.admin, { ...report, host: "desk", from: "subscribe", version: 2 })).status, 204);
    assert.equal((await post(t.member, { ...report, version: 4 })).status, 204);

    let r = await req(t.app, "GET", "/v1/installs?name=skills/deploy", t.member);
    assert.equal(r.status, 200);
    const list = (await r.json()) as Install[];
    assert.deepEqual(
      list.map((i) => [i.user.name, i.host, i.version, i.from]).sort(),
      [
        ["admin", "desk", 2, "subscribe"],
        ["dev", "laptop", 4, "install"],
      ],
    );
    r = await req(t.app, "GET", "/v1/installs?agent=cursor", t.member);
    assert.deepEqual(await r.json(), []);
  });

  test("bad body is 400", async () => {
    assert.equal((await post(t.member, { ...report, from: "copy" })).status, 400);
    assert.equal((await post(t.member, { ...report, version: 0 })).status, 400);
    assert.equal((await post(t.member, { ...report, name: " " })).status, 400);
  });
});
