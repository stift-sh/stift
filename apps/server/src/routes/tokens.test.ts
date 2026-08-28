import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TokenCreated, TokenInfo, Whoami } from "@stift/shared";
import { createTestApp, req, skip, type TestApp } from "./harness.js";

describe("tokens routes", { skip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp();
  });
  after(() => t.close());

  const create = (token: string, body: string) => req(t.app, "POST", "/v1/tokens", token, body, "application/json");

  test("auth required", async () => {
    const r = await req(t.app, "GET", "/v1/tokens");
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "missing bearer token" });
  });

  test("lifecycle: tokens belong to the caller", async () => {
    let r = await create(t.admin, JSON.stringify({ name: "laptop" }));
    assert.equal(r.status, 201);
    const created = (await r.json()) as TokenCreated;
    assert.ok(created.token.startsWith("stf_"));
    assert.equal(created.admin, true); // the admin's own token
    assert.equal(created.user?.name, "admin");

    r = await req(t.app, "GET", "/v1/whoami", created.token);
    const me = (await r.json()) as Whoami;
    assert.equal(me.name, "laptop");
    assert.equal(me.role, "admin");
    assert.equal(me.user?.name, "admin");
    assert.deepEqual(me.org, { id: "", slug: "default", name: "Default" });

    r = await req(t.app, "GET", "/v1/tokens", t.admin);
    const list = (await r.json()) as TokenInfo[];
    assert.deepEqual(list.map((x) => [x.name, x.user?.name]), [["admin", "admin"], ["dev", "dev"], ["laptop", "admin"]]);

    r = await req(t.app, "DELETE", `/v1/tokens/${created.id}`, t.admin);
    assert.equal(r.status, 204);
    r = await req(t.app, "GET", "/v1/whoami", created.token);
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "invalid token" });
  });

  test("members see and manage only their own tokens", async () => {
    let r = await req(t.app, "GET", "/v1/whoami", t.member);
    const me = (await r.json()) as Whoami;
    assert.equal(me.admin, false);
    assert.equal(me.role, "member");

    r = await create(t.member, JSON.stringify({ name: "phone" }));
    assert.equal(r.status, 201);
    const mine = (await r.json()) as TokenCreated;
    assert.equal(mine.admin, false);
    assert.equal(mine.user?.name, "dev");

    r = await create(t.member, JSON.stringify({ name: "x", admin: true }));
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: "admin token required" });

    r = await req(t.app, "GET", "/v1/tokens", t.member);
    const list = (await r.json()) as TokenInfo[];
    assert.deepEqual(list.map((x) => x.name), ["dev", "phone"]);

    // Someone else's token: 404, not 403.
    const admins = (await (await req(t.app, "GET", "/v1/tokens", t.admin)).json()) as TokenInfo[];
    const adminId = admins.find((x) => x.name === "admin")!.id;
    r = await req(t.app, "DELETE", `/v1/tokens/${adminId}`, t.member);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "no such token" });

    r = await req(t.app, "DELETE", `/v1/tokens/${mine.id}`, t.member);
    assert.equal(r.status, 204);
  });

  test("validation", async () => {
    const me = (await (await req(t.app, "GET", "/v1/tokens", t.admin)).json()) as TokenInfo[];
    let r = await req(t.app, "DELETE", `/v1/tokens/${me.find((x) => x.name === "admin")!.id}`, t.admin);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "refusing to revoke the token used for this request" });

    r = await req(t.app, "DELETE", "/v1/tokens/nope", t.admin);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "no such token" });

    r = await create(t.admin, JSON.stringify({ name: "" }));
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "name is required" });

    r = await create(t.admin, "{not json");
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /^bad request body: /);
  });
});
