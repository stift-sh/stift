// Port of TestBundlePushFlow, TestBundleStaleAndMissingBlob and
// TestBundleOrgScopeRequiresAdmin in the former Go server (git history before 2026-08-27) engine/server/handlers_bundles_test.go.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Bundle, BundleInput, TokenCreated } from "@stift/shared";
import { createTestApp, req, resetDb, skip, type TestApp } from "./harness.js";

const shaOf = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

describe("bundles routes", { skip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp();
  });
  after(() => t.close());
  beforeEach(() => resetDb(t.db));

  const putBlob = async (token: string, content: Uint8Array) => {
    const sha = shaOf(content);
    const r = await t.app.request(`/v1/blobs/${sha}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Length": String(content.byteLength) },
      body: content as BodyInit,
    });
    assert.equal(r.status, 200, `put blob: ${await r.text()}`);
    return sha;
  };
  const putBundle = (token: string, path: string, m: BundleInput) => req(t.app, "PUT", path, token, JSON.stringify(m), "application/json");
  const getJson = async <T>(token: string, path: string) => {
    const r = await req(t.app, "GET", path, token);
    return { status: r.status, body: (await r.json()) as T };
  };

  test("push flow", async () => {
    const skill = bytes("---\nname: hello\ndescription: says hi\n---\n# Hello\n");
    const claude = bytes("# CLAUDE.md\n");
    const shas = [shaOf(skill), shaOf(claude)];
    const check = () => req(t.app, "POST", "/v1/blobs/check", t.admin, JSON.stringify({ shas }), "application/json");

    let missing = ((await (await check()).json()) as { missing: string[] }).missing;
    assert.equal(missing.length, 2);
    await putBlob(t.admin, skill);
    await putBlob(t.admin, skill);
    await putBlob(t.admin, claude);
    missing = ((await (await check()).json()) as { missing: string[] }).missing;
    assert.equal(missing.length, 0);

    const manifest: BundleInput = {
      host: "h1",
      files: [
        { path: "SKILL.md", sha256: shas[0]!, size: skill.byteLength, mode: 0o644 },
        { path: "NOTES.md", sha256: shas[1]!, size: claude.byteLength, mode: 0o644 },
      ],
    };
    let r = await putBundle(t.admin, "/v1/bundles/user/claude/skills/hello", manifest);
    assert.equal(r.status, 201, await r.clone().text());
    const v1 = (await r.json()) as Bundle;
    assert.equal(v1.version, 1);
    assert.equal(v1.scope, "user");
    assert.equal(v1.agent, "claude");
    assert.equal(v1.name, "skills/hello");
    assert.equal(v1.author, "admin");
    assert.deepEqual(v1.skills.map((s) => [s.path, s.name, s.description]), [["SKILL.md", "hello", "says hi"]]);

    r = await putBundle(t.admin, "/v1/bundles/user/claude/skills/hello", { ...manifest, parent: 1, files: manifest.files!.slice(0, 1) });
    const v2 = (await r.json()) as Bundle;
    assert.equal(v2.version, 2);
    assert.equal(v2.parent, 1);

    const head = await getJson<Bundle>(t.admin, "/v1/bundles/user/claude/skills/hello");
    const old = await getJson<Bundle>(t.admin, "/v1/bundles/user/claude/skills/hello?version=1");
    assert.equal(head.body.version, 2);
    assert.equal(old.body.version, 1);
    assert.equal(old.body.files.length, 2);
    assert.equal((await getJson(t.admin, "/v1/bundles/user/codex/skills/hello")).status, 404);
    r = await req(t.app, "GET", "/v1/bundles/user/claude/skills/hello?version=x", t.admin);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "version must be a non-negative integer" });

    const hist = await getJson<Bundle[]>(t.admin, "/v1/bundles/user/claude/skills/hello?history=1");
    assert.deepEqual(hist.body.map((b) => b.version), [2, 1]);

    const other: BundleInput = { files: [{ path: "CLAUDE.md", sha256: shas[1]!, size: claude.byteLength, mode: 0o644 }] };
    r = await putBundle(t.admin, "/v1/bundles/user/claude/CLAUDE.md", other);
    const o1 = (await r.json()) as Bundle;
    assert.equal(o1.version, 1);
    assert.equal(o1.name, "CLAUDE.md");
    assert.equal((await getJson<Bundle>(t.admin, "/v1/bundles/user/claude/skills/hello")).body.version, 2);

    let list = await getJson<Bundle[]>(t.admin, "/v1/bundles?scope=user");
    assert.deepEqual(list.body.map((b) => [b.name, b.version]), [["CLAUDE.md", 1], ["skills/hello", 2]]);
    list = await getJson<Bundle[]>(t.admin, "/v1/bundles?scope=user&name=skills/hello");
    assert.deepEqual(list.body.map((b) => b.name), ["skills/hello"]);

    for (const bad of ["a/b/c/d", "a%2F..%2Fx", "a.%00b"]) {
      r = await putBundle(t.admin, `/v1/bundles/user/claude/${bad}`, other);
      assert.ok(r.status === 400 || r.status === 404, `name ${bad}: ${r.status}`);
    }
    assert.equal((await getJson(t.admin, "/v1/bundles/user/claude/a/b/c/d?history=1")).status, 400);
    assert.equal((await getJson(t.admin, "/v1/bundles/user/claude/skills/nope?history=1")).status, 404);

    r = await req(t.app, "DELETE", "/v1/bundles/user/claude/skills/hello", t.admin);
    assert.equal(r.status, 204);
    list = await getJson<Bundle[]>(t.admin, "/v1/bundles");
    assert.deepEqual(list.body.map((b) => b.name), ["CLAUDE.md"]);
    r = await req(t.app, "DELETE", "/v1/bundles/user/claude/skills/hello", t.admin);
    assert.equal(r.status, 404);
  });

  test("stale and missing blob", async () => {
    const sha = await putBlob(t.admin, bytes("hi\n"));
    const m: BundleInput = { files: [{ path: "CLAUDE.md", sha256: sha, size: 3, mode: 0o644 }] };
    let r = await putBundle(t.admin, "/v1/bundles/user/claude/CLAUDE.md", m);
    assert.equal(r.status, 201);

    r = await putBundle(t.admin, "/v1/bundles/user/claude/CLAUDE.md", m);
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: "stale: current head is version 1, bundle parent is 0" });

    r = await putBundle(t.admin, "/v1/bundles/user/claude/CLAUDE.md?force=1", m);
    assert.equal(((await r.json()) as Bundle).version, 2);

    const missing = "a".repeat(64);
    r = await putBundle(t.admin, "/v1/bundles/user/claude/CLAUDE.md", { parent: 2, files: [{ path: "x.md", sha256: missing, size: 1, mode: 0o644 }] });
    assert.equal(r.status, 412);
    assert.match(((await r.json()) as { error: string }).error, new RegExp(missing));

    r = await putBundle(t.admin, "/v1/bundles/user/claude/CLAUDE.md", { parent: 2, files: [{ path: "../etc/passwd", sha256: sha, size: 3, mode: 0o644 }] });
    assert.equal(r.status, 400);
    r = await putBundle(t.admin, "/v1/bundles/project/claude/CLAUDE.md", m);
    assert.equal(r.status, 400);
    r = await putBundle(t.admin, "/v1/bundles/user/claude/CLAUDE.md", "{nope" as unknown as BundleInput);
    assert.equal(r.status, 400);
  });

  test("org scope requires admin", async () => {
    const r0 = await req(t.app, "POST", "/v1/tokens", t.admin, JSON.stringify({ name: "dev", admin: false }), "application/json");
    const user = ((await r0.json()) as TokenCreated).token;
    const sha = await putBlob(user, bytes("org\n"));
    const m: BundleInput = { files: [{ path: "CLAUDE.md", sha256: sha, size: 4, mode: 0o644 }] };

    let r = await putBundle(user, "/v1/bundles/org/claude/CLAUDE.md", m);
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: "org scope requires an admin token" });
    r = await putBundle(t.admin, "/v1/bundles/org/claude/CLAUDE.md", m);
    assert.equal(r.status, 201);
    assert.equal((await getJson(user, "/v1/bundles/org/claude/CLAUDE.md")).status, 200);
    r = await req(t.app, "DELETE", "/v1/bundles/org/claude/CLAUDE.md", user);
    assert.equal(r.status, 403);
    r = await putBundle(user, "/v1/bundles/user/claude/CLAUDE.md", m);
    assert.equal(r.status, 201);
  });
});
