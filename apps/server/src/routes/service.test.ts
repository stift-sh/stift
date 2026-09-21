import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Org } from "@stift/shared";
import { createApp } from "../app.js";
import { createToken } from "../auth/tokens.js";
import { memberships, orgs, users } from "../db/schema.js";
import { setOrgLimits } from "../limits.js";
import { SERVICE_TOKEN, createTestApp, req, resetDb, skip, type TestApp } from "./harness.js";

const ORG = "org_service_test";
const UNLIMITED = { maxSkills: null, maxStorageBytes: null, maxSeats: null, maxSessions: null };

describe("service API", { skip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp();
  });
  // Other suites share the default org; leave it unlimited.
  after(async () => {
    await setOrgLimits(t.db, "", UNLIMITED);
    await t.db.delete(orgs).where(eq(orgs.id, ORG));
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
    await setOrgLimits(t.db, "", UNLIMITED);
  });

  // The default org's id is "", which no path can carry; the service API is
  // for the multi-org server, so the tests get an org with a real id.
  const seed = async () => {
    await t.db.delete(orgs).where(eq(orgs.id, ORG));
    await t.db.delete(users).where(eq(users.id, "svc-user"));
    await t.db.delete(users).where(eq(users.name, "leaver"));
    await t.db.insert(orgs).values({ id: ORG, slug: "service-test", name: "Service Test" });
    await t.db.insert(users).values({ id: "svc-user", name: "svc" });
    await t.db.insert(memberships).values({ orgId: ORG, userId: "svc-user", role: "admin" });
  };
  beforeEach(seed);

  const put = (body: unknown, org = ORG, token = SERVICE_TOKEN) =>
    req(t.app, "PUT", `/v1/service/orgs/${org}/limits`, token, JSON.stringify(body), "application/json");

  test("only the service token opens it; user tokens do not", async () => {
    const path = `/v1/service/orgs/${ORG}`;
    assert.equal((await req(t.app, "GET", path)).status, 401);
    for (const token of [t.admin, "nope", SERVICE_TOKEN + "x", SERVICE_TOKEN.slice(0, -1)]) {
      const r = await req(t.app, "GET", path, token);
      assert.equal(r.status, 401, token);
      assert.deepEqual(await r.json(), { error: "invalid token" });
    }
    assert.equal((await req(t.app, "GET", path, SERVICE_TOKEN)).status, 200);
    // And the service token is no identity for the rest of the API.
    assert.equal((await req(t.app, "GET", "/v1/org", SERVICE_TOKEN)).status, 401);
  });

  test("not mounted without a service token", async () => {
    const app = createApp({ version: "test", auth: t.auth, store: t.store, db: t.db });
    assert.equal((await req(app, "GET", `/v1/service/orgs/${ORG}`, SERVICE_TOKEN)).status, 401);
    assert.equal((await req(app, "GET", `/v1/service/orgs/${ORG}`, t.admin)).status, 404);
  });

  test("GET org: limits and usage, 404 for an unknown org", async () => {
    const r = await req(t.app, "GET", `/v1/service/orgs/${ORG}`, SERVICE_TOKEN);
    assert.deepEqual(await r.json(), {
      id: ORG,
      slug: "service-test",
      name: "Service Test",
      slug_locked: false,
      limits: { skills: null, storage_bytes: null, seats: null, sessions: null },
      usage: { skills: 0, storage_bytes: 0, seats: 1, sessions: 0 },
    });
    assert.equal((await req(t.app, "GET", "/v1/service/orgs/nope", SERVICE_TOKEN)).status, 404);
  });

  test("PUT limits: sets, leaves absent ones, null clears", async () => {
    let r = await put({ max_skills: 10, max_storage_bytes: 5_000_000_000, max_seats: 3, max_sessions: 100 });
    assert.equal(r.status, 200);
    assert.deepEqual(((await r.json()) as Org).limits, { skills: 10, storage_bytes: 5_000_000_000, seats: 3, sessions: 100 });

    r = await put({ max_sessions: null });
    assert.deepEqual(((await r.json()) as Org).limits, { skills: 10, storage_bytes: 5_000_000_000, seats: 3, sessions: null });
    r = await put({});
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as Org).limits.skills, 10);

    // Only this org.
    const mine = (await (await req(t.app, "GET", "/v1/org", t.admin)).json()) as Org;
    assert.deepEqual(mine.limits, { skills: null, storage_bytes: null, seats: null, sessions: null });

    for (const bad of [{ max_skills: 0 }, { max_seats: -1 }, { max_sessions: 1.5 }, { max_skills: "10" }]) {
      assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await put({ max_skills: 1 }, "nope")).status, 404);
  });

  test("DELETE member: removes the membership and the tokens", async () => {
    const { raw } = await createToken(t.db, ORG, "leaver-laptop", { newUser: { name: "leaver", role: "member" } });
    const who = await req(t.app, "GET", "/v1/whoami", raw);
    assert.equal(who.status, 200);
    const id = ((await who.json()) as { user: { id: string } }).user.id;

    const del = (token = SERVICE_TOKEN) => req(t.app, "DELETE", `/v1/service/orgs/${ORG}/members/${id}`, token);
    assert.equal((await del(t.admin)).status, 401);
    assert.equal((await del()).status, 204);
    assert.equal((await req(t.app, "GET", "/v1/whoami", raw)).status, 401);
    assert.equal((await del()).status, 404);
    const o = (await (await req(t.app, "GET", `/v1/service/orgs/${ORG}`, SERVICE_TOKEN)).json()) as Org;
    assert.equal(o.usage.seats, 1);
  });
});
