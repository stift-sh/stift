// The public registry (skills-registry-4, item 3): what anyone can read
// without a token, and what stays private.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { BundleInput, RegistrySearch, RegistrySkill } from "@stift/shared";
import { createApp } from "../app.js";
import { createTestApp, req, resetDb, skip, type TestApp } from "./harness.js";

const shaOf = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

describe("registry routes", { skip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp();
  });
  const resetOrg = () => t.db.execute(sql`update orgs set slug = 'default', name = 'Default' where id = ''`);
  after(async () => {
    await resetOrg();
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
    await resetOrg();
    await req(t.app, "PATCH", "/v1/org", t.admin, JSON.stringify({ slug: "acme" }), "application/json");
  });

  const putBlob = async (content: Uint8Array) => {
    const r = await t.app.request(`/v1/blobs/${shaOf(content)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${t.admin}`, "Content-Length": String(content.byteLength) },
      body: content as BodyInit,
    });
    assert.equal(r.status, 200, await r.text());
    return { sha256: shaOf(content), size: content.byteLength, mode: 0o644 };
  };
  const putUnit = async (path: string, files: Record<string, string>, parent = 0) => {
    const m: BundleInput = { parent, host: "h1", files: [] };
    for (const [p, c] of Object.entries(files)) m.files!.push({ path: p, ...(await putBlob(bytes(c))) });
    const r = await req(t.app, "PUT", `/v1/bundles/org/claude/${path}`, t.admin, JSON.stringify(m), "application/json");
    assert.equal(r.status, 201, await r.clone().text());
  };
  const skillMd = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`;
  const publish = async (unit: string, extra: Record<string, unknown> = {}) => {
    const r = await req(t.app, "POST", "/v1/published", t.admin, JSON.stringify({ agent: "claude", unit, license: "MIT", ...extra }), "application/json");
    assert.equal(r.status, 201, await r.clone().text());
  };
  const unpublish = async (name: string, version?: number) => {
    const r = await req(t.app, "DELETE", `/v1/published/${name}${version ? `?version=${version}` : ""}`, t.admin);
    assert.equal(r.status, 204);
  };
  const get = (path: string) => t.app.request(path);
  const skill = async (path: string) => {
    const r = await get(path);
    assert.equal(r.status, 200, `${path}: ${await r.clone().text()}`);
    return { body: (await r.json()) as RegistrySkill, cache: r.headers.get("cache-control") };
  };
  const search = async (qs = "") => {
    const r = await get(`/v1/registry/skills${qs}`);
    assert.equal(r.status, 200, await r.clone().text());
    return (await r.json()) as RegistrySearch;
  };

  test("resolves a ref and serves its blobs without a token", async () => {
    const script = "#!/bin/sh\necho deploy\n";
    await putUnit("skills/deploy", { "SKILL.md": skillMd("deploy", "ships it"), "scripts/run.sh": script });
    await publish("skills/deploy");

    const latest = await skill("/v1/registry/skills/@acme/deploy");
    assert.equal(latest.cache, "public, max-age=60");
    assert.deepEqual([latest.body.skill.org, latest.body.skill.name, latest.body.skill.latest, latest.body.skill.license], ["acme", "deploy", 1, "MIT"]);
    assert.deepEqual([latest.body.version.version, latest.body.version.readme_path, latest.body.version.unpublished_at], [1, "SKILL.md", null]);
    assert.deepEqual(latest.body.version.files.map((f) => f.path), ["SKILL.md", "scripts/run.sh"]);

    const v1 = await skill("/v1/registry/skills/@acme/deploy/1");
    assert.equal(v1.cache, "public, max-age=31536000, immutable");
    assert.deepEqual(v1.body, latest.body);

    const r = await get(`/v1/registry/skills/@acme/deploy/1/blobs/${shaOf(bytes(script))}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(r.headers.get("content-type"), "application/octet-stream");
    assert.equal(await r.text(), script);

    // Unknown refs, versions and syntax are all plain 404s.
    for (const p of [
      "/v1/registry/skills/@acme/nope",
      "/v1/registry/skills/@other/deploy",
      "/v1/registry/skills/acme/deploy",
      "/v1/registry/skills/@acme/deploy/2",
      "/v1/registry/skills/@acme/deploy/latest",
      "/v1/registry/skills/@acme/deploy/0",
    ]) {
      assert.equal((await get(p)).status, 404, p);
    }
  });

  test("a private blob's sha 404s through the public path", async () => {
    await putUnit("skills/deploy", { "SKILL.md": skillMd("deploy", "ships it") });
    await publish("skills/deploy");
    // Same org, never published.
    const secret = bytes("token=hunter2\n");
    await putUnit("skills/secret", { "SKILL.md": skillMd("secret", "internal"), "notes.txt": "token=hunter2\n" });
    assert.equal((await req(t.app, "GET", `/v1/blobs/${shaOf(secret)}`, t.member)).status, 200);

    assert.equal((await get(`/v1/registry/skills/@acme/deploy/1/blobs/${shaOf(secret)}`)).status, 404);
    // Wrong version of the right skill, or a sha that is not hex.
    assert.equal((await get(`/v1/registry/skills/@acme/deploy/2/blobs/${shaOf(bytes(skillMd("deploy", "ships it")))}`)).status, 404);
    assert.equal((await get("/v1/registry/skills/@acme/deploy/1/blobs/nothex")).status, 404);
    // And the token-only route still needs one.
    assert.equal((await get(`/v1/blobs/${shaOf(secret)}`)).status, 401);
  });

  test("an unpublished version resolves by number but not as latest", async () => {
    await putUnit("skills/deploy", { "SKILL.md": skillMd("deploy", "one") });
    await publish("skills/deploy");
    await putUnit("skills/deploy", { "SKILL.md": skillMd("deploy", "two") }, 1);
    await publish("skills/deploy");
    assert.equal((await skill("/v1/registry/skills/@acme/deploy")).body.version.version, 2);

    await unpublish("deploy", 2);
    const latest = await skill("/v1/registry/skills/@acme/deploy");
    assert.deepEqual([latest.body.skill.latest, latest.body.version.version], [1, 1]);
    const v2 = await skill("/v1/registry/skills/@acme/deploy/2");
    assert.equal(v2.body.version.version, 2);
    assert.ok(v2.body.version.unpublished_at, "hidden version says so");
    assert.equal(v2.body.skill.unpublished_at, null);
    // Its blobs keep resolving so an existing install can verify itself.
    const r = await get(`/v1/registry/skills/@acme/deploy/2/blobs/${shaOf(bytes(skillMd("deploy", "two")))}`);
    assert.equal(r.status, 200);

    // Hiding the whole skill removes `latest`; numbers still work.
    await unpublish("deploy");
    assert.equal((await get("/v1/registry/skills/@acme/deploy")).status, 404);
    const v1 = await skill("/v1/registry/skills/@acme/deploy/1");
    assert.ok(v1.body.skill.unpublished_at);
    assert.equal(v1.body.version.unpublished_at, null);
    assert.deepEqual(await search(), { skills: [], next: null });

    // Hiding every version one by one: latest is 0, so the ref is gone too.
    await req(t.app, "POST", "/v1/published/deploy/restore", t.admin);
    await unpublish("deploy", 1);
    assert.equal((await get("/v1/registry/skills/@acme/deploy")).status, 404);
    assert.equal((await skill("/v1/registry/skills/@acme/deploy/1")).body.skill.latest, 0);
  });

  test("search matches name, description and org, newest first, with a cursor", async () => {
    for (const [n, d] of [
      ["alpha", "first thing"],
      ["beta", "deploys stuff"],
      ["gamma", "third"],
    ] as const) {
      await putUnit(`skills/${n}`, { "SKILL.md": skillMd(n, d) });
      await publish(`skills/${n}`);
    }
    const names = (s: RegistrySearch) => s.skills.map((x) => x.name);

    let s = await search();
    assert.deepEqual(names(s), ["gamma", "beta", "alpha"]);
    assert.equal(s.next, null);
    assert.equal((await get("/v1/registry/skills")).headers.get("cache-control"), "public, max-age=60");

    assert.deepEqual(names(await search("?q=DEPLOY")), ["beta"]);
    assert.deepEqual(names(await search("?q=alph")), ["alpha"]);
    assert.deepEqual(names(await search("?q=acme")), ["gamma", "beta", "alpha"]);
    assert.deepEqual(names(await search("?q=%25")), []);
    assert.deepEqual(names(await search("?q=zzz")), []);

    s = await search("?limit=2");
    assert.deepEqual(names(s), ["gamma", "beta"]);
    assert.ok(s.next);
    s = await search(`?limit=2&cursor=${encodeURIComponent(s.next!)}`);
    assert.deepEqual([names(s), s.next], [["alpha"], null]);
    assert.deepEqual(await search("?cursor=garbage"), { skills: [], next: null });
    assert.equal((await get("/v1/registry/skills?limit=0")).status, 400);

    // A new publish moves a skill to the front; hiding it drops it.
    await putUnit("skills/alpha", { "SKILL.md": skillMd("alpha", "first thing, again") }, 1);
    await publish("skills/alpha");
    assert.deepEqual(names(await search()), ["alpha", "gamma", "beta"]);
    await unpublish("beta");
    assert.deepEqual(names(await search()), ["alpha", "gamma"]);
  });

  test("STIFT_REGISTRY=off hides the routes and refuses publishes", async () => {
    await putUnit("skills/deploy", { "SKILL.md": skillMd("deploy", "ships it") });
    await publish("skills/deploy");
    const off = createApp({ version: "test", auth: t.auth, store: t.store, db: t.db, registry: false });
    const headers = { Authorization: `Bearer ${t.admin}` };

    assert.equal((await off.request("/v1/registry/skills")).status, 401);
    assert.equal((await off.request("/v1/registry/skills/@acme/deploy", { headers })).status, 404);
    const r = await off.request("/v1/published", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ agent: "claude", unit: "skills/deploy" }) });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { error: string }).error, "publishing is off on this server (STIFT_REGISTRY=off)");
    // Admin management of what was published still works.
    assert.equal((await off.request("/v1/published", { headers })).status, 200);
    assert.equal((await off.request("/v1/published/deploy", { method: "DELETE", headers })).status, 204);
    assert.deepEqual((await (await off.request("/api/version")).json()).features, []);
    assert.deepEqual((await (await t.app.request("/api/version")).json()).features, ["registry"]);
  });
});
