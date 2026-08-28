import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Member, MemberCreated, TokenCreated, TokenInfo, Whoami } from "@stift/shared";
import { createTestApp, req, skip, type TestApp } from "./harness.js";

describe("members routes", { skip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp();
  });
  after(() => t.close());

  const post = (token: string, body: unknown) => req(t.app, "POST", "/v1/members", token, JSON.stringify(body), "application/json");
  const patch = (token: string, id: string, body: unknown) =>
    req(t.app, "PATCH", `/v1/members/${id}`, token, JSON.stringify(body), "application/json");

  test("auth required", async () => {
    const r = await req(t.app, "GET", "/v1/members");
    assert.equal(r.status, 401);
  });

  test("list is open to members, management is admin only", async () => {
    let r = await req(t.app, "GET", "/v1/members", t.member);
    assert.equal(r.status, 200);
    const list = (await r.json()) as Member[];
    assert.deepEqual(list.map((m) => [m.name, m.role, m.tokens]), [["admin", "admin", 1], ["dev", "member", 1]]);

    r = await post(t.member, { name: "eve" });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: "admin token required" });
    r = await patch(t.member, list[0]!.id, { role: "member" });
    assert.equal(r.status, 403);
    r = await req(t.app, "DELETE", `/v1/members/${list[0]!.id}`, t.member);
    assert.equal(r.status, 403);
  });

  test("lifecycle: add with a first token, promote, demote, remove", async () => {
    let r = await post(t.admin, { name: "sam", email: "sam@example.com", token: "sam-laptop" });
    assert.equal(r.status, 201);
    const sam = (await r.json()) as MemberCreated;
    assert.equal(sam.role, "member");
    assert.equal(sam.email, "sam@example.com");
    assert.equal(sam.tokens, 1);
    assert.ok(sam.token?.startsWith("stf_"));

    r = await req(t.app, "GET", "/v1/whoami", sam.token);
    const me = (await r.json()) as Whoami;
    assert.equal(me.name, "sam-laptop");
    assert.equal(me.role, "member");
    assert.equal(me.user?.name, "sam");

    // Duplicate name.
    r = await post(t.admin, { name: "sam" });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'user "sam" already exists' });
    r = await post(t.admin, { name: "  " });
    assert.equal(r.status, 400);

    // Promote (by name), the role applies to the existing token at once.
    r = await patch(t.admin, "sam", { role: "admin" });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as Member).role, "admin");
    r = await req(t.app, "GET", "/v1/whoami", sam.token);
    assert.equal(((await r.json()) as Whoami).role, "admin");

    // Demote (by id).
    r = await patch(t.admin, sam.id, { role: "member" });
    assert.equal(r.status, 200);
    r = await patch(t.admin, sam.id, { role: "owner" });
    assert.equal(r.status, 400);
    r = await patch(t.admin, "nobody", { role: "admin" });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "no such member" });

    // Remove: tokens go with the membership.
    r = await req(t.app, "DELETE", `/v1/members/${sam.id}`, t.admin);
    assert.equal(r.status, 204);
    r = await req(t.app, "GET", "/v1/whoami", sam.token);
    assert.equal(r.status, 401);
    r = await req(t.app, "DELETE", `/v1/members/${sam.id}`, t.admin);
    assert.equal(r.status, 404);
  });

  test("guards: last admin, self removal", async () => {
    const list = (await (await req(t.app, "GET", "/v1/members", t.admin)).json()) as Member[];
    const admin = list.find((m) => m.name === "admin")!;
    let r = await patch(t.admin, admin.id, { role: "member" });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "refusing to demote the last admin" });
    r = await req(t.app, "DELETE", `/v1/members/${admin.id}`, t.admin);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "refusing to remove yourself" });
  });

  test("admins mint tokens for other members with `user`", async () => {
    const create = (token: string, body: unknown) => req(t.app, "POST", "/v1/tokens", token, JSON.stringify(body), "application/json");
    let r = await create(t.admin, { name: "dev-phone", user: "dev" });
    assert.equal(r.status, 201);
    const tok = (await r.json()) as TokenCreated;
    assert.equal(tok.user?.name, "dev");
    assert.equal(tok.admin, false);
    r = await req(t.app, "GET", "/v1/whoami", tok.token);
    assert.equal(((await r.json()) as Whoami).role, "member");

    // The member sees it among their own.
    r = await req(t.app, "GET", "/v1/tokens", t.member);
    assert.ok(((await r.json()) as TokenInfo[]).some((x) => x.name === "dev-phone"));

    r = await create(t.admin, { name: "x", user: "nobody" });
    assert.equal(r.status, 404);
    r = await create(t.member, { name: "x", user: "admin" });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: "admin token required" });
  });
});
