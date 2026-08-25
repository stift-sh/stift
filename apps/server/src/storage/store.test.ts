// Port of cli/engine/server/backendtest: the contract every Store must pass.
// Runs against the docker-compose services when STIFT_TEST_DATABASE_URL is
// set; skipped otherwise.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import type { BundleFile } from "@stift/shared";
import { connect, runMigrations } from "../db/client.js";
import { BlobStore } from "./blobs.js";
import { MissingBlobError, NotFoundError, StaleError } from "./errors.js";
import { PgStore, type BundleKey, type Store } from "./store.js";

const dbUrl = process.env.STIFT_TEST_DATABASE_URL;

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const rd = (s: string | Buffer) => Readable.from([Buffer.from(s)]);
const readAll = async (r: Readable) => Buffer.concat(await r.toArray());

async function putBlob(b: Store, tenant: string, p: string, content: string): Promise<BundleFile> {
  await b.putBlob(tenant, sha(content), rd(content), Buffer.byteLength(content));
  return { path: p, sha256: sha(content), size: Buffer.byteLength(content), mode: 0o644 };
}

const rejects = (p: Promise<unknown>, cls: (new (...a: never[]) => Error) | undefined, msg: string) =>
  assert.rejects(p, (e: unknown) => (cls ? e instanceof cls || assert.fail(`${msg}: got ${e}`) : true), msg);

describe("Store contract", { skip: dbUrl ? false : "STIFT_TEST_DATABASE_URL not set" }, () => {
  let conn: ReturnType<typeof connect>;
  let b: Store;

  before(async () => {
    conn = connect(dbUrl!);
    await runMigrations(conn.db);
    const blobStore = new BlobStore({
      bucket: process.env.STIFT_S3_BUCKET ?? "stift",
      endpoint: process.env.STIFT_S3_ENDPOINT ?? "http://localhost:9000",
      region: process.env.STIFT_S3_REGION ?? "us-east-1",
      accessKeyId: process.env.STIFT_S3_ACCESS_KEY ?? "stift",
      secretAccessKey: process.env.STIFT_S3_SECRET_KEY ?? "stiftstift",
      forcePathStyle: true,
      prefix: "test",
    });
    b = new PgStore(conn.db, blobStore);
  });
  beforeEach(async () => {
    await conn.db.execute(sql`truncate sessions, blobs, bundles, bundle_versions, tokens`);
  });
  after(async () => {
    await conn.pool.end();
  });

  test("Blobs", async () => {
    const data = "hello world";
    const id = sha(data);
    assert.deepEqual(await b.hasBlobs("", [id]), [id]);
    await b.putBlob("", id, rd(data), data.length);
    await b.putBlob("", id, rd(data), data.length); // idempotent re-put
    assert.deepEqual(await b.hasBlobs("", [id, sha("other")]), [sha("other")]);
    assert.equal((await readAll(await b.openBlob("", id))).toString(), data);
    // Hash mismatch is rejected and leaves nothing behind.
    const bad = sha("not this");
    await rejects(b.putBlob("", bad, rd(data), data.length), undefined, "hash mismatch accepted");
    assert.equal((await b.hasBlobs("", [bad])).length, 1, "rejected blob became visible");
    // Size mismatch is rejected.
    await rejects(b.putBlob("", sha("zzz"), rd("zzz"), 99), undefined, "size mismatch accepted");
    // Bad sha strings are rejected.
    await rejects(b.putBlob("", "nothex", rd(data), data.length), undefined, "invalid sha accepted");
    await rejects(b.openBlob("", sha("never")), NotFoundError, "openBlob of unknown blob succeeded");
  });

  test("BundleVersioning", async () => {
    const k: BundleKey = { scope: "user", agent: "claude", name: "CLAUDE.md" };
    const f1 = await putBlob(b, "", "CLAUDE.md", "# one");
    assert.equal(await b.getBundle("", k, 0), undefined, "getBundle on empty store returned a bundle");

    const v1 = await b.putBundle("", k, { parent: 0, host: "h", author: "me", files: [f1] });
    assert.equal(v1.version, 1);
    assert.equal(v1.scope, "user");
    assert.equal(v1.agent, "claude");
    assert.equal(v1.name, "CLAUDE.md");
    assert.ok(v1.created);
    assert.ok(Array.isArray(v1.skills) && Array.isArray(v1.files), "files/skills should be arrays");

    // Wrong parent -> StaleError.
    const f2 = await putBlob(b, "", "CLAUDE.md", "# two");
    await rejects(b.putBundle("", k, { parent: 0, files: [f2] }), StaleError, "expected StaleError");
    assert.equal((await b.getBundle("", k, 0))?.version, 1, "stale write changed HEAD");
    // Correct parent advances.
    assert.equal((await b.putBundle("", k, { parent: 1, files: [f2] })).version, 2);
    // Force ignores parent.
    const v3 = await b.putBundle("", k, { parent: 0, files: [f1] }, true);
    assert.equal(v3.version, 3);
    assert.equal(v3.parent, 0);

    // Version 0 = HEAD; explicit versions resolve; unknown versions do not.
    assert.equal((await b.getBundle("", k, 0))?.version, 3);
    const old = await b.getBundle("", k, 2);
    assert.equal(old?.version, 2);
    assert.equal(old?.files[0]?.sha256, f2.sha256);
    assert.equal(await b.getBundle("", k, 4), undefined, "future version found");
    // Key fields come from the key, not the body.
    await b.putBundle("", k, { parent: 3 });
    const got = await b.getBundle("", k, 0);
    assert.deepEqual([got?.scope, got?.agent, got?.name, got?.version], ["user", "claude", "CLAUDE.md", 4]);
    // Invalid keys are rejected.
    await rejects(b.putBundle("", { scope: "nope", agent: "claude", name: "x" }, {}), undefined, "invalid scope accepted");
    await rejects(b.putBundle("", { scope: "user", agent: "../x", name: "x" }, {}), undefined, "traversal agent accepted");
    await rejects(b.putBundle("", { scope: "project", agent: "claude", name: "x" }, {}), undefined, "project scope without project accepted");
    for (const name of ["", "/abs", "../x", "a/../b", "a/./b", "./a", "a//b", "a/", "a\\b", "C:/x", "a/b/c/d", "a\nb"]) {
      await rejects(b.putBundle("", { scope: "user", agent: "claude", name }, {}), undefined, `unit name ${JSON.stringify(name)} accepted`);
    }
    for (const name of ["CLAUDE.md", "skills/a", ".claude/skills/a", "commands/fix-tests"]) {
      await b.putBundle("", { scope: "user", agent: "claude", name }, {}, true);
    }
  });

  test("BundleHistory", async () => {
    const k: BundleKey = { scope: "project", agent: "claude", project: "/home/me/app", name: ".claude/CLAUDE.md" };
    assert.equal((await b.bundleHistory("", k)).length, 0);
    for (let i = 0; i < 3; i++) {
      const f = await putBlob(b, "", "CLAUDE.md", "x".repeat(i + 1));
      await b.putBundle("", k, { parent: i, files: [f] });
    }
    const h = await b.bundleHistory("", k);
    assert.deepEqual(h.map((x) => x.version), [3, 2, 1]);
    for (const x of h) {
      assert.equal(x.project, k.project);
      assert.equal(x.name, k.name);
    }
  });

  test("TenantIsolation", async () => {
    const data = "shared content";
    const id = sha(data);
    await b.putBlob("orgA", id, rd(data), data.length);
    assert.equal((await b.hasBlobs("orgB", [id])).length, 1, "blob leaked across tenants");
    assert.equal((await b.hasBlobs("", [id])).length, 1, "blob leaked to default tenant");
    await rejects(b.openBlob("orgB", id), NotFoundError, "openBlob across tenants succeeded");

    const k: BundleKey = { scope: "user", agent: "claude", name: "CLAUDE.md" };
    const f: BundleFile = { path: "CLAUDE.md", sha256: id, size: data.length, mode: 0 };
    await b.putBundle("orgA", k, { files: [f] });
    await rejects(b.putBundle("orgB", k, { files: [f] }), MissingBlobError, "expected MissingBlobError across tenants");
    assert.equal(await b.getBundle("orgB", k, 0), undefined, "bundle leaked across tenants");
    assert.equal(await b.getBundle("", k, 0), undefined, "bundle leaked to default tenant");
    assert.equal((await b.listBundles("orgB", {})).length, 0);
    // Independent version counters.
    await putBlob(b, "orgB", "CLAUDE.md", data);
    assert.equal((await b.putBundle("orgB", k, { files: [f] })).version, 1);
    await b.deleteBundle("orgB", k);
    assert.ok(await b.getBundle("orgA", k, 0), "deleting orgB's bundle removed orgA's");
    // Invalid tenant names are rejected.
    await rejects(b.putBlob("../x", id, rd(data), data.length), undefined, "invalid tenant accepted by putBlob");
    await rejects(b.putBundle("../x", k, {}), undefined, "invalid tenant accepted by putBundle");
  });

  test("MissingBlob", async () => {
    const k: BundleKey = { scope: "user", agent: "claude", name: "skills/x" };
    const have = await putBlob(b, "", "a.md", "a");
    const ghost: BundleFile = { path: "b.md", sha256: sha("never uploaded"), size: 14, mode: 0 };
    await rejects(b.putBundle("", k, { files: [have, ghost] }), MissingBlobError, "expected MissingBlobError");
    assert.equal(await b.getBundle("", k, 0), undefined, "rejected bundle was stored");
    await b.putBundle("", k, {}); // empty bundle is fine
  });

  test("BadPaths", async () => {
    const k: BundleKey = { scope: "user", agent: "claude", name: "skills/x" };
    const ok = await putBlob(b, "", "ok.md", "ok");
    for (const p of ["", "/abs.md", "../up.md", "a/../b.md", "a/./b.md", "./a.md", "a//b.md", "a/b/", "a\\b.md", "C:/x.md"]) {
      await rejects(b.putBundle("", k, { files: [{ ...ok, path: p }] }), undefined, `path ${JSON.stringify(p)} accepted`);
    }
    await rejects(b.putBundle("", k, { files: [ok, ok] }), undefined, "duplicate path accepted");
    await rejects(b.putBundle("", k, { files: [{ ...ok, sha256: "xyz" }] }), undefined, "bad sha accepted");
    assert.equal(await b.getBundle("", k, 0), undefined, "a rejected bundle was stored");
    await b.putBundle("", k, { files: [{ ...ok, path: "scripts/review/run.sh" }] });
  });

  test("Delete", async () => {
    const k: BundleKey = { scope: "org", agent: "claude", name: "CLAUDE.md" };
    await rejects(b.deleteBundle("", k), NotFoundError, "deleting unknown bundle succeeded");
    const f = await putBlob(b, "", "CLAUDE.md", "x");
    for (let i = 0; i < 2; i++) await b.putBundle("", k, { parent: i, files: [f] });
    await b.deleteBundle("", k);
    assert.equal(await b.getBundle("", k, 0), undefined, "bundle still visible after delete");
    assert.equal(await b.getBundle("", k, 1), undefined, "old version still visible after delete");
    assert.equal((await b.bundleHistory("", k)).length, 0);
    assert.equal((await b.listBundles("", {})).length, 0);
    // Blobs survive (content-addressed; gc is separate).
    assert.equal((await b.hasBlobs("", [f.sha256])).length, 0, "delete removed a blob");
    // Versioning restarts from 1 after delete.
    assert.equal((await b.putBundle("", k, { parent: 0, files: [f] })).version, 1);
  });

  test("SkillFrontmatter", async () => {
    const k: BundleKey = { scope: "user", agent: "claude", name: "skills/review" };
    const s1 = await putBlob(b, "", "SKILL.md", '---\nname: review\ndescription: "Review a diff: carefully"\nother: x\n---\n# Body\nname: not-this\n');
    const s2 = await putBlob(b, "", "deploy/SKILL.md", "# No frontmatter\nname: nope\n");
    const s3 = await putBlob(b, "", "zz/SKILL.md", "---\ndescription: 'single quoted'\n---\n");
    const notSkill = await putBlob(b, "", "README.md", "---\nname: readme\n---\n");
    const v = await b.putBundle("", k, { files: [s3, notSkill, s1, s2] });
    assert.deepEqual(v.skills, [
      { path: "SKILL.md", name: "review", description: "Review a diff: carefully" },
      { path: "deploy/SKILL.md", name: "", description: "" },
      { path: "zz/SKILL.md", name: "", description: "single quoted" },
    ]);
    // Persisted, not just returned.
    const got = await b.getBundle("", k, 0);
    assert.equal(got?.skills.length, 3);
    assert.equal(got?.skills[0]?.name, "review");
  });

  test("ListBundles", async () => {
    const f = await putBlob(b, "", "CLAUDE.md", "c");
    const keys: BundleKey[] = [
      { scope: "user", agent: "claude", name: "CLAUDE.md" },
      { scope: "user", agent: "claude", name: "skills/a" },
      { scope: "user", agent: "codex", name: "AGENTS.md" },
      { scope: "project", agent: "claude", project: "/p1", name: "CLAUDE.md" },
      { scope: "project", agent: "claude", project: "/p2", name: "CLAUDE.md" },
      { scope: "org", agent: "claude", name: "skills/a" },
    ];
    for (const k of keys) await b.putBundle("", k, { files: [f] });
    await b.putBundle("", keys[0]!, { parent: 1 }); // bump one so HEADs are listed
    const all = await b.listBundles("", {});
    assert.equal(all.length, 6);
    for (const x of all) {
      if (x.scope === "user" && x.agent === "claude" && x.name === "CLAUDE.md") assert.equal(x.version, 2, "non-HEAD listed");
      if (x.scope === "user" && x.agent === "claude" && x.name === "skills/a") assert.equal(x.version, 1, "sibling bumped");
    }
    // Sorted by scope, agent, project, name.
    assert.equal(all[0]!.scope, "org");
    assert.equal(all[1]!.project, "/p1");
    assert.equal(all[3]!.name, "CLAUDE.md");
    assert.equal(all[4]!.name, "skills/a");
    assert.equal(all[5]!.agent, "codex");
    assert.equal((await b.listBundles("", { name: "skills/a" })).length, 2);
    const sn = await b.listBundles("", { scope: "org", name: "skills/a" });
    assert.equal(sn.length, 1);
    assert.equal(sn[0]!.scope, "org");
    assert.equal((await b.listBundles("", { scope: "project" })).length, 2);
    const ag = await b.listBundles("", { agent: "codex" });
    assert.equal(ag.length, 1);
    assert.equal(ag[0]!.agent, "codex");
    const pr = await b.listBundles("", { scope: "project", project: "/p2" });
    assert.equal(pr.length, 1);
    assert.equal(pr[0]!.project, "/p2");
  });

  test("Units", async () => {
    const mk = (name: string): BundleKey => ({ scope: "user", agent: "claude", name });
    const [a, bb, nested, top] = [mk("skills/a"), mk("skills/b"), mk("skills/a/sub"), mk("skills")];
    const f = await putBlob(b, "", "SKILL.md", "---\nname: a\n---\n");
    for (let i = 0; i < 3; i++) await b.putBundle("", a, { parent: i, files: [f] });
    for (const k of [bb, nested, top]) {
      const v = await b.putBundle("", k, { files: [f] });
      assert.equal(v.version, 1);
      assert.equal(v.name, k.name);
    }
    assert.equal((await b.getBundle("", a, 0))?.version, 3, "skills/a moved");
    const hb = await b.bundleHistory("", bb);
    assert.equal(hb.length, 1);
    assert.equal(hb[0]!.name, "skills/b");
    assert.equal((await b.bundleHistory("", a)).length, 3);
    // Stale detection is per unit.
    await rejects(b.putBundle("", bb, { parent: 3, files: [f] }), StaleError, "expected StaleError for skills/b parent 3");
    // Deleting a prefix unit keeps the units nested below it, and vice versa.
    await b.deleteBundle("", top);
    for (const k of [a, bb, nested]) assert.ok(await b.getBundle("", k, 0), `deleting skills removed ${k.name}`);
    await b.deleteBundle("", a);
    assert.ok(await b.getBundle("", nested, 0), "deleting skills/a removed skills/a/sub");
    assert.equal(await b.getBundle("", a, 0), undefined, "skills/a still present");
    assert.equal((await b.listBundles("", { scope: "user" })).length, 2);
    // Versioning of the deleted unit restarts; siblings unaffected.
    assert.equal((await b.putBundle("", a, { files: [f] })).version, 1);
    assert.equal((await b.getBundle("", nested, 0))?.version, 1);
  });

  // Sessions are not covered by the Go backendtest suite (its DiskStore
  // tests live in store_test.go); the semantics ported here are the same.
  test("Sessions", async () => {
    const meta = {
      key: "claude/host/abc",
      agent: "claude",
      session_id: "abc-123",
      project: "/home/me/app",
      host: "host",
      title: "Fix the tests",
      base: "home" as const,
      files: 3,
      mod_time: "2026-08-26T10:00:00.000Z",
    };
    const r1 = await b.put("", meta, rd("archive-1"));
    assert.equal(r1.status, "created");
    assert.equal(r1.session.sha256, sha("archive-1"));
    assert.equal(r1.session.size, 9);
    assert.equal(r1.session.mod_time, meta.mod_time);
    assert.equal((await b.put("", meta, rd("archive-1"))).status, "unchanged");
    const r2 = await b.put("", meta, rd("archive-two"));
    assert.equal(r2.status, "updated");
    assert.equal(r2.session.id, r1.session.id);
    assert.equal(r2.session.created_at, r1.session.created_at);
    assert.equal(r2.session.sha256, sha("archive-two"));
    const arch = await b.openArchive("", r1.session.id);
    assert.equal((await readAll(arch.body)).toString(), "archive-two");
    assert.deepEqual(await b.get("", r1.session.id), r2.session);

    const r3 = await b.put("", { ...meta, key: "codex/host/x", agent: "codex", session_id: "zzz", title: "Other" }, rd("a"));
    assert.equal(r3.status, "created");
    assert.equal((await b.list("")).length, 2);
    assert.equal((await b.list("", { agent: "codex" }))[0]?.id, r3.session.id);
    assert.equal((await b.list("", { query: "TESTS" }))[0]?.id, r1.session.id);
    assert.equal((await b.list("", { query: "abc-1" })).length, 1);
    assert.equal((await b.list("", { host: "nope" })).length, 0);
    assert.equal((await b.list("orgA")).length, 0, "sessions leaked across tenants");

    assert.equal(await b.resolveId("", r1.session.id), r1.session.id);
    assert.equal(await b.resolveId("", r1.session.id.slice(0, 6)), r1.session.id);
    await rejects(b.resolveId("", "ffffffffffffffffffff"), NotFoundError, "unknown prefix resolved");
    await rejects(b.resolveId("", ""), undefined, "empty prefix resolved");

    await b.delete("", r1.session.id);
    assert.equal(await b.get("", r1.session.id), undefined);
    await rejects(b.openArchive("", r1.session.id), NotFoundError, "archive survived delete");
    await rejects(b.delete("", r1.session.id), NotFoundError, "double delete succeeded");
  });
});
