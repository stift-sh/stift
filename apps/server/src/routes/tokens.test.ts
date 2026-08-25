import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TokenCreated, TokenInfo } from "@stift/shared";
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

  test("lifecycle and admin gate", async () => {
    let r = await create(t.admin, JSON.stringify({ name: "laptop" }));
    assert.equal(r.status, 201);
    const created = (await r.json()) as TokenCreated;
    assert.ok(created.token.startsWith("stf_"));
    assert.equal(created.admin, false);

    // Non-admin token can use the API but not mint tokens.
    r = await req(t.app, "GET", "/v1/whoami", created.token);
    assert.deepEqual(await r.json(), { name: "laptop", admin: false });
    r = await create(created.token, JSON.stringify({ name: "x" }));
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: "admin token required" });

    r = await req(t.app, "GET", "/v1/tokens", t.admin);
    const list = (await r.json()) as TokenInfo[];
    assert.deepEqual(list.map((x) => x.name), ["admin", "laptop"]);

    r = await req(t.app, "DELETE", `/v1/tokens/${created.id}`, t.admin);
    assert.equal(r.status, 204);
    r = await req(t.app, "GET", "/v1/whoami", created.token);
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "invalid token" });
  });

  test("validation", async () => {
    const me = (await (await req(t.app, "GET", "/v1/tokens", t.admin)).json()) as TokenInfo[];
    let r = await req(t.app, "DELETE", `/v1/tokens/${me[0]!.id}`, t.admin);
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
