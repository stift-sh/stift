// Publishing (skills-registry-4, item 2): the org's side of public sharing.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { BundleInput, Org, PublishedSkillDetail, PublishedVersion } from "@stift/shared";
import { createTestApp, req, resetDb, skip, type TestApp } from "./harness.js";

const shaOf = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

describe("published routes", { skip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp();
  });
  // Other suites expect the seeded slug.
  const resetOrg = () => t.db.execute(sql`update orgs set slug = 'default', name = 'Default' where id = ''`);
  after(async () => {
    await resetOrg();
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
    await resetOrg();
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
  /** Writes an org-scope unit; `files` maps path → content. Returns the new version. */
  const putUnit = async (path: string, files: Record<string, string>, parent = 0, scope = "org") => {
    const m: BundleInput = { parent, host: "h1", files: [] };
    for (const [p, c] of Object.entries(files)) m.files!.push({ path: p, ...(await putBlob(bytes(c))) });
    const r = await req(t.app, "PUT", `/v1/bundles/${scope}/claude/${path}`, t.admin, JSON.stringify(m), "application/json");
    assert.equal(r.status, 201, await r.clone().text());
    return ((await r.json()) as { version: number }).version;
  };
  const skillMd = (desc: string, body = "# Deploy\n") => `---\nname: deploy\ndescription: ${desc}\n---\n${body}`;
  const setSlug = async (slug: string) => {
    const r = await req(t.app, "PATCH", "/v1/org", t.admin, JSON.stringify({ slug }), "application/json");
    assert.equal(r.status, 200, await r.clone().text());
  };
  const publish = (token: string, body: unknown) => req(t.app, "POST", "/v1/published", token, JSON.stringify(body), "application/json");
  const list = async (token = t.member) => {
    const r = await req(t.app, "GET", "/v1/published", token);
    assert.equal(r.status, 200);
    return (await r.json()) as PublishedSkillDetail[];
  };
  const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;

  test("admins only; a slug must be set first", async () => {
    await putUnit("skills/deploy", { "SKILL.md": skillMd("ships it") });
    const body = { agent: "claude", unit: "skills/deploy", license: "MIT" };
    assert.equal((await publish("", body)).status, 401);
    let r = await publish(t.member, body);
    assert.equal(r.status, 403);
    assert.equal(await errorOf(r), "admin role required");

    r = await publish(t.admin, body);
    assert.equal(r.status, 400);
    assert.equal(await errorOf(r), "set an org slug before publishing");
    assert.deepEqual(await list(), []);
  });

  test("publish copies the manifest, numbers versions in sequence and refreshes the description", async () => {
    await setSlug("acme");
    await putUnit("skills/deploy", { "SKILL.md": skillMd("ships it"), "scripts/run.sh": "#!/bin/sh\n" });

    let r = await publish(t.admin, { agent: "claude", unit: "skills/deploy" });
    assert.equal(r.status, 400);
    assert.equal(await errorOf(r), "license is required on the first publish");

    r = await publish(t.admin, { agent: "claude", unit: "skills/deploy", license: "MIT" });
    assert.equal(r.status, 201, await r.clone().text());
    const v1 = (await r.json()) as PublishedVersion;
    assert.equal(v1.org, "acme");
    assert.equal(v1.name, "deploy");
    assert.deepEqual([v1.version, v1.source_version, v1.readme_path, v1.unpublished_at], [1, 1, "SKILL.md", null]);
    assert.deepEqual(v1.files.map((f) => f.path), ["SKILL.md", "scripts/run.sh"]);
    assert.deepEqual(v1.skills.map((s) => s.description), ["ships it"]);
    assert.equal(v1.published_by?.name, "admin");

    // The same manifest again is a conflict.
    r = await publish(t.admin, { agent: "claude", unit: "skills/deploy" });
    assert.equal(r.status, 409);
    assert.equal(await errorOf(r), "already published as version 1");

    // Head moves twice; publishing head gives version 2 from source 3, and
    // the description follows the newest publish.
    await putUnit("skills/deploy", { "SKILL.md": skillMd("ships it, v2") }, 1);
    await putUnit("skills/deploy", { "SKILL.md": skillMd("ships it, v3") }, 2);
    r = await publish(t.admin, { agent: "claude", unit: "skills/deploy" });
    assert.equal(r.status, 201);
    const v2 = (await r.json()) as PublishedVersion;
    assert.deepEqual([v2.version, v2.source_version], [2, 3]);

    const [skill] = await list();
    assert.equal(skill!.org, "acme");
    assert.deepEqual([skill!.name, skill!.agent, skill!.unit, skill!.description, skill!.license, skill!.latest, skill!.unpublished_at], [
      "deploy",
      "claude",
      "skills/deploy",
      "ships it, v3",
      "MIT",
      2,
      null,
    ]);
    assert.deepEqual(skill!.versions.map((v) => [v.version, v.source_version]), [[2, 3], [1, 1]]);
    // Members read the same list.
    assert.deepEqual(await list(t.admin), [skill]);
  });

  test("an older source version can be published; the license can change", async () => {
    await setSlug("acme");
    await putUnit("skills/deploy", { "SKILL.md": skillMd("one") });
    await putUnit("skills/deploy", { "SKILL.md": skillMd("two") }, 1);
    let r = await publish(t.admin, { agent: "claude", unit: "skills/deploy", license: "MIT", version: 1 });
    assert.equal(r.status, 201, await r.clone().text());
    assert.deepEqual([((await r.json()) as PublishedVersion).source_version], [1]);

    r = await publish(t.admin, { agent: "claude", unit: "skills/deploy", license: "Apache-2.0" });
    assert.equal(r.status, 201);
    const [skill] = await list();
    assert.deepEqual([skill!.license, skill!.description, skill!.latest], ["Apache-2.0", "two", 2]);

    r = await publish(t.admin, { agent: "claude", unit: "skills/deploy", version: 9 });
    assert.equal(r.status, 404);
  });

  test("the published copy survives edits, rollback and deletion of the unit", async () => {
    await setSlug("acme");
    await putUnit("skills/deploy", { "SKILL.md": skillMd("one") });
    assert.equal((await publish(t.admin, { agent: "claude", unit: "skills/deploy", license: "MIT" })).status, 201);
    const before = (await list())[0]!;
    assert.equal((await req(t.app, "DELETE", "/v1/bundles/org/claude/skills/deploy", t.admin)).status, 204);
    const after = (await list())[0]!;
    assert.deepEqual(after.versions, before.versions);
    // The blobs it references are still there.
    const sha = after.versions[0]!.files[0]!.sha256;
    assert.equal((await req(t.app, "GET", `/v1/blobs/${sha}`, t.member)).status, 200);
  });

  test("names: default, override, charset, fixed to one unit", async () => {
    await setSlug("acme");
    await putUnit("skills/deploy", { "SKILL.md": skillMd("one") });
    await putUnit("skills/other", { "SKILL.md": skillMd("other") });
    let r = await publish(t.admin, { agent: "claude", unit: "skills/deploy", license: "MIT", name: "Deploy Tool" });
    assert.equal(r.status, 400);
    assert.match(await errorOf(r), /^invalid name/);

    r = await publish(t.admin, { agent: "claude", unit: "skills/deploy", license: "MIT", name: "deploy-tool" });
    assert.equal(r.status, 201);
    assert.equal(((await r.json()) as PublishedVersion).name, "deploy-tool");

    // Another unit cannot take the name.
    r = await publish(t.admin, { agent: "claude", unit: "skills/other", license: "MIT", name: "deploy-tool" });
    assert.equal(r.status, 409);
    assert.equal(await errorOf(r), "@acme/deploy-tool is published from claude skills/deploy, not claude skills/other");

    // Bad licenses.
    r = await publish(t.admin, { agent: "claude", unit: "skills/other", license: "MIT OR Apache-2.0" });
    assert.equal(r.status, 400);
    assert.match(await errorOf(r), /^invalid license/);
  });

  test("only org-scope units with a SKILL.md", async () => {
    await setSlug("acme");
    await putUnit("skills/mine", { "SKILL.md": skillMd("mine") }, 0, "user");
    let r = await publish(t.admin, { agent: "claude", unit: "skills/mine", license: "MIT" });
    assert.equal(r.status, 404);

    await putUnit("CLAUDE.md", { "CLAUDE.md": "# rules\n" });
    r = await publish(t.admin, { agent: "claude", unit: "CLAUDE.md", license: "MIT" });
    assert.equal(r.status, 400);
    assert.equal(await errorOf(r), "CLAUDE.md has no SKILL.md");

    // A nested SKILL.md counts; the shallowest one is the README.
    await putUnit("skills/nested", { "a/SKILL.md": skillMd("deep"), "SKILL.md": skillMd("top") });
    r = await publish(t.admin, { agent: "claude", unit: "skills/nested", license: "MIT" });
    assert.equal(r.status, 201);
    assert.equal(((await r.json()) as PublishedVersion).readme_path, "SKILL.md");
    assert.equal((await list()).find((s) => s.name === "nested")!.description, "top");
  });

  test("unpublish and restore: one version, or the whole skill", async () => {
    await setSlug("acme");
    await putUnit("skills/deploy", { "SKILL.md": skillMd("one") });
    await putUnit("skills/deploy", { "SKILL.md": skillMd("two") }, 1);
    assert.equal((await publish(t.admin, { agent: "claude", unit: "skills/deploy", license: "MIT", version: 1 })).status, 201);
    assert.equal((await publish(t.admin, { agent: "claude", unit: "skills/deploy" })).status, 201);
    const del = (token: string, path: string) => req(t.app, "DELETE", path, token);
    const restore = (token: string, path: string) => req(t.app, "POST", path, token);

    assert.equal((await del(t.member, "/v1/published/deploy")).status, 403);
    assert.equal((await del(t.admin, "/v1/published/nope")).status, 404);
    assert.equal((await del(t.admin, "/v1/published/deploy?version=9")).status, 404);
    assert.equal((await del(t.admin, "/v1/published/deploy?version=x")).status, 400);

    // Hiding v2 moves latest back to v1; v2 stays listed, marked.
    assert.equal((await del(t.admin, "/v1/published/deploy?version=2")).status, 204);
    let [skill] = await list();
    assert.equal(skill!.latest, 1);
    assert.deepEqual(skill!.versions.map((v) => [v.version, v.unpublished_at !== null]), [[2, true], [1, false]]);

    // Publishing the same manifest as a hidden version is still a conflict.
    let r = await publish(t.admin, { agent: "claude", unit: "skills/deploy" });
    assert.equal(r.status, 409);
    assert.equal(await errorOf(r), "already published as version 2");

    assert.equal((await restore(t.admin, "/v1/published/deploy/restore?version=2")).status, 204);
    [skill] = await list();
    assert.equal(skill!.latest, 2);
    assert.ok(skill!.versions.every((v) => v.unpublished_at === null));

    // The whole skill.
    assert.equal((await del(t.admin, "/v1/published/deploy")).status, 204);
    [skill] = await list();
    assert.ok(skill!.unpublished_at !== null);
    assert.equal(skill!.latest, 2);
    assert.equal((await restore(t.member, "/v1/published/deploy/restore")).status, 403);
    assert.equal((await restore(t.admin, "/v1/published/deploy/restore")).status, 204);
    assert.equal((await list())[0]!.unpublished_at, null);

    // Hiding every version leaves latest at 0; a new publish brings the
    // skill back.
    assert.equal((await del(t.admin, "/v1/published/deploy?version=1")).status, 204);
    assert.equal((await del(t.admin, "/v1/published/deploy?version=2")).status, 204);
    assert.equal((await del(t.admin, "/v1/published/deploy")).status, 204);
    assert.equal((await list())[0]!.latest, 0);
    await putUnit("skills/deploy", { "SKILL.md": skillMd("three") }, 2);
    r = await publish(t.admin, { agent: "claude", unit: "skills/deploy" });
    assert.equal(r.status, 201);
    [skill] = await list();
    assert.deepEqual([skill!.latest, skill!.unpublished_at], [3, null]);
  });

  test("the slug locks once anything is published, hidden or not", async () => {
    await setSlug("acme");
    await putUnit("skills/deploy", { "SKILL.md": skillMd("one") });
    assert.equal((await publish(t.admin, { agent: "claude", unit: "skills/deploy", license: "MIT" })).status, 201);
    const org = async () => (await (await req(t.app, "GET", "/v1/org", t.member)).json()) as Org;
    assert.equal((await org()).slug_locked, true);

    const r = await req(t.app, "PATCH", "/v1/org", t.admin, JSON.stringify({ slug: "other" }), "application/json");
    assert.equal(r.status, 409);
    assert.equal(await errorOf(r), "slug is locked: 1 published skills");
    // The name and the same slug are still fine.
    assert.equal((await req(t.app, "PATCH", "/v1/org", t.admin, JSON.stringify({ slug: "acme", name: "Acme" }), "application/json")).status, 200);

    assert.equal((await req(t.app, "DELETE", "/v1/published/deploy", t.admin)).status, 204);
    assert.equal((await org()).slug_locked, true);
  });
});
