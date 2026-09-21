import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { BundleInput, Org } from "@stift/shared";
import { bootstrap } from "../auth/bootstrap.js";
import { orgLimitsFromEnv, setOrgLimits } from "../limits.js";
import { sql } from "drizzle-orm";
import { ensureDefaultOrg } from "../auth/bootstrap.js";
import { createTestApp, pushSession, req, resetDb, skip, testMeta, type TestApp } from "./harness.js";

const shaOf = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);
const UNLIMITED = { maxSkills: null, maxStorageBytes: null, maxSeats: null, maxSessions: null };

describe("org limits", { skip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp();
  });
  // Other suites share the default org; leave it unlimited.
  after(async () => {
    await setOrgLimits(t.db, "", UNLIMITED);
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
    await setOrgLimits(t.db, "", UNLIMITED);
  });

  const putBlob = (token: string, content: Uint8Array) =>
    t.app.request(`/v1/blobs/${shaOf(content)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Length": String(content.byteLength) },
      body: content as BodyInit,
    });
  const putSkill = async (token: string, name: string, content: string, parent = 0) => {
    const c = bytes(content);
    const blob = await putBlob(token, c);
    assert.equal(blob.status, 200, await blob.clone().text());
    const m: BundleInput = { parent, host: "h1", files: [{ path: "SKILL.md", sha256: shaOf(c), size: c.byteLength, mode: 0o644 }] };
    return req(t.app, "PUT", `/v1/bundles/user/claude/skills/${name}`, token, JSON.stringify(m), "application/json");
  };
  const getOrg = async (token: string) => (await (await req(t.app, "GET", "/v1/org", token)).json()) as Org;

  test("GET /v1/org: auth required, open to members, unlimited by default", async () => {
    assert.equal((await req(t.app, "GET", "/v1/org")).status, 401);
    const r = await req(t.app, "GET", "/v1/org", t.member);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      id: "",
      slug: "default",
      name: "Default",
      slug_locked: false,
      limits: { skills: null, storage_bytes: null, seats: null, sessions: null },
      usage: { skills: 0, storage_bytes: 0, seats: 2, sessions: 0 },
    });
  });

  test("max_skills: a new unit over the limit is 402, new versions are not", async () => {
    await setOrgLimits(t.db, "", { maxSkills: 1 });
    assert.equal((await putSkill(t.admin, "one", "# one\n")).status, 201);

    const r = await putSkill(t.member, "two", "# two\n");
    assert.equal(r.status, 402);
    assert.deepEqual(await r.json(), { error: "limit: 1 skills per org" });
    // The rejected unit leaves nothing behind.
    assert.equal((await req(t.app, "GET", "/v1/bundles/user/claude/skills/two", t.member)).status, 404);

    assert.equal((await putSkill(t.admin, "one", "# one, again\n", 1)).status, 201);
    const o = await getOrg(t.admin);
    assert.deepEqual([o.limits.skills, o.usage.skills], [1, 1]);

    // Deleting frees the slot.
    assert.equal((await req(t.app, "DELETE", "/v1/bundles/user/claude/skills/one", t.admin)).status, 204);
    assert.equal((await putSkill(t.member, "two", "# two\n")).status, 201);
  });

  test("max_storage_bytes: a blob over the limit is 402, a stored one is a no-op", async () => {
    const a = bytes("a".repeat(60));
    const b = bytes("b".repeat(60));
    await setOrgLimits(t.db, "", { maxStorageBytes: 100 });
    assert.equal((await putBlob(t.admin, a)).status, 200);

    const r = await putBlob(t.admin, b);
    assert.equal(r.status, 402);
    assert.deepEqual(await r.json(), { error: "limit: 100 bytes of storage per org" });
    assert.equal((await req(t.app, "GET", `/v1/blobs/${shaOf(b)}`, t.admin)).status, 404);

    assert.equal((await putBlob(t.admin, a)).status, 200);
    assert.equal((await putBlob(t.admin, bytes("c".repeat(40)))).status, 200);
    assert.equal((await getOrg(t.admin)).usage.storage_bytes, 100);
  });

  test("max_seats: adding a member over the limit is 402", async () => {
    await setOrgLimits(t.db, "", { maxSeats: 3 });
    const add = (name: string) => req(t.app, "POST", "/v1/members", t.admin, JSON.stringify({ name }), "application/json");
    let r = await add("seat-three");
    assert.equal(r.status, 201);
    const { id } = (await r.json()) as { id: string };

    r = await add("seat-four");
    assert.equal(r.status, 402);
    assert.deepEqual(await r.json(), { error: "limit: 3 seats per org" });
    assert.equal((await getOrg(t.admin)).usage.seats, 3);

    // Removing frees the seat (and keeps the org at two members for other tests).
    assert.equal((await req(t.app, "DELETE", `/v1/members/${id}`, t.admin)).status, 204);
    r = await add("seat-four");
    assert.equal(r.status, 201);
    await req(t.app, "DELETE", `/v1/members/${((await r.json()) as { id: string }).id}`, t.admin);
  });

  test("max_sessions: a new session over the limit is 402, re-pushing one is not", async () => {
    await setOrgLimits(t.db, "", { maxSessions: 1 });
    const push = (key: string, payload: string) => pushSession(t.app, t.member, { ...testMeta(), key, session_id: key }, bytes(payload));
    assert.equal((await push("h/claude/one", "v1")).status, 201);

    const r = await push("h/claude/two", "v1");
    assert.equal(r.status, 402);
    assert.deepEqual(await r.json(), { error: "limit: 1 sessions per org" });
    assert.equal((await push("h/claude/one", "v2")).status, 200);
    const o = await getOrg(t.admin);
    assert.equal(o.usage.sessions, 1);
    assert.equal(o.limits.sessions, 1);

    // Deleting frees the slot.
    const [s] = (await (await req(t.app, "GET", "/v1/sessions", t.admin)).json()) as { id: string }[];
    assert.equal((await req(t.app, "DELETE", `/v1/sessions/${s!.id}`, t.admin)).status, 204);
    assert.equal((await push("h/claude/two", "v1")).status, 201);
  });

  describe("PATCH /v1/org", () => {
    const patch = (token: string | undefined, body: unknown) => req(t.app, "PATCH", "/v1/org", token, JSON.stringify(body), "application/json");
    // Other suites expect the seeded org.
    const reset = async () => {
      await t.db.execute(sql`delete from orgs where id = 'other'`);
      await t.db.execute(sql`update orgs set slug = 'default', name = 'Default' where id = ''`);
    };
    beforeEach(reset);
    after(reset);

    test("admins only", async () => {
      assert.equal((await patch(undefined, { slug: "acme" })).status, 401);
      const r = await patch(t.member, { slug: "acme" });
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: "admin role required" });
      assert.equal((await getOrg(t.admin)).slug, "default");
    });

    test("sets name and slug, each on its own", async () => {
      let r = await patch(t.admin, { slug: "acme" });
      assert.equal(r.status, 200);
      let o = (await r.json()) as Org;
      assert.deepEqual([o.slug, o.name, o.slug_locked], ["acme", "Default", false]);

      r = await patch(t.admin, { name: "  Acme Inc  " });
      o = (await r.json()) as Org;
      assert.deepEqual([o.slug, o.name], ["acme", "Acme Inc"]);
      assert.deepEqual(await getOrg(t.member), o);

      // Nothing to change, and the current slug again, are both fine.
      assert.equal((await patch(t.admin, {})).status, 200);
      assert.equal((await patch(t.admin, { slug: "acme" })).status, 200);
    });

    test("invalid slugs and names are 400", async () => {
      for (const slug of ["a", "Acme", "-acme", "ac me", "acme_inc", "@acme", "a".repeat(40), ""]) {
        const r = await patch(t.admin, { slug });
        assert.equal(r.status, 400, slug);
        assert.match(((await r.json()) as { error: string }).error, /^invalid slug/);
      }
      assert.equal((await patch(t.admin, { name: "   " })).status, 400);
      assert.equal((await getOrg(t.admin)).slug, "default");
    });

    test("a slug another org holds is 409", async () => {
      await t.db.execute(sql`insert into orgs (id, slug, name) values ('other', 'taken', 'Other')`);
      const r = await patch(t.admin, { slug: "taken" });
      assert.equal(r.status, 409);
      assert.deepEqual(await r.json(), { error: 'slug "taken" is taken' });
    });

    test("STIFT_ORG_SLUG sets the seeded slug once, and is validated", async () => {
      assert.equal((await ensureDefaultOrg(t.db, { STIFT_ORG_SLUG: "acme" })).slug, "acme");
      assert.equal((await ensureDefaultOrg(t.db, { STIFT_ORG_SLUG: "other" })).slug, "acme");
      await assert.rejects(ensureDefaultOrg(t.db, { STIFT_ORG_SLUG: "Not Valid" }), /STIFT_ORG_SLUG/);
    });
  });

  test("env sets the default org's limits on start; unset leaves the row alone", async () => {
    assert.deepEqual(orgLimitsFromEnv({}), {});
    assert.deepEqual(orgLimitsFromEnv({ STIFT_MAX_SKILLS: "5", STIFT_MAX_SEATS: "unlimited", STIFT_MAX_SESSIONS: "100" }), { maxSkills: 5, maxSeats: null, maxSessions: 100 });
    assert.throws(() => orgLimitsFromEnv({ STIFT_MAX_STORAGE_BYTES: "0" }), /STIFT_MAX_STORAGE_BYTES: expected a positive integer/);

    await bootstrap(t.db, { STIFT_MAX_SKILLS: "5", STIFT_MAX_STORAGE_BYTES: "1000" }, () => {});
    assert.deepEqual((await getOrg(t.admin)).limits, { skills: 5, storage_bytes: 1000, seats: null, sessions: null });
    await bootstrap(t.db, { STIFT_MAX_SKILLS: "unlimited" }, () => {});
    assert.deepEqual((await getOrg(t.admin)).limits, { skills: null, storage_bytes: 1000, seats: null, sessions: null });
  });
});
