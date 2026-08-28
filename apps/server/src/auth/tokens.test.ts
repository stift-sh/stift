import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { connect, runMigrations } from "../db/client.js";
import { memberships, orgs } from "../db/schema.js";
import { bootstrap, ensureDefaultOrg } from "./bootstrap.js";
import { TokenAuthenticator, createToken, hashToken, listTokens, registerToken, revokeToken } from "./tokens.js";

const dbUrl = process.env.STIFT_TEST_DATABASE_URL;

// Minted by the Go server (former Go server, engine/server/tokens.go in git history); hash must match exactly.
const GO_RAW = "stf_000102030405060708090a0b0c0d0e0f101112131415161718";

describe("local tokens", { skip: dbUrl ? false : "STIFT_TEST_DATABASE_URL not set" }, () => {
  let conn: ReturnType<typeof connect>;
  before(async () => {
    conn = connect(dbUrl!);
    await runMigrations(conn.db);
  });
  beforeEach(async () => {
    await conn.db.execute(sql`truncate tokens, memberships, users cascade`);
    await conn.db.execute(sql`delete from orgs where id <> ''`);
    await ensureDefaultOrg(conn.db, {});
    await conn.db.insert(orgs).values({ id: "org_1", slug: "org-1", name: "Org 1" });
  });
  after(() => conn.pool.end());

  test("create / check round-trip, format, wrong token", async () => {
    const { raw, info } = await createToken(conn.db, "", "ci", false);
    assert.match(raw, /^stf_[0-9a-f]{48}$/);
    assert.match(info.id, /^[0-9a-f]{8}$/);
    const auth = new TokenAuthenticator(conn.db);
    const id = await auth.authenticate(raw);
    assert.equal(id?.userId.length, 16);
    assert.deepEqual(id, { id: info.id, userId: id!.userId, orgId: "", name: "ci", role: "member", admin: false });
    assert.equal(await auth.authenticate(raw.slice(0, -1) + (raw.endsWith("0") ? "1" : "0")), null);
    assert.equal(await auth.authenticate("nope"), null);
  });

  test("hash is Go-compatible and register is idempotent", async () => {
    // sha256 of GO_RAW, as Go's hashToken produces it.
    assert.equal(hashToken(GO_RAW), "81adc8ce02d69ccd3451406e2f6590d822374d88732caccbba92e07569806383");
    const a = await registerToken(conn.db, "", GO_RAW, "env-admin", true);
    const b = await registerToken(conn.db, "", GO_RAW, "other-name", false);
    assert.deepEqual(a, b);
    assert.equal((await listTokens(conn.db, "")).length, 1);
  });

  test("org is carried through and scopes list/revoke", async () => {
    const { raw, info } = await createToken(conn.db, "org_1", "cli", true);
    const id = await new TokenAuthenticator(conn.db).authenticate(raw);
    assert.equal(id?.orgId, "org_1");
    assert.equal((await listTokens(conn.db, "")).length, 0);
    assert.equal(await revokeToken(conn.db, "", info.id), false);
    assert.equal(await revokeToken(conn.db, "org_1", info.id), true);
    assert.equal(await new TokenAuthenticator(conn.db).authenticate(raw), null);
  });

  test("bootstrap: env token, else first-start token, both idempotent", async () => {
    const logs: string[] = [];
    await bootstrap(conn.db, { STIFT_ADMIN_TOKEN: GO_RAW }, (m) => logs.push(m));
    await bootstrap(conn.db, { STIFT_ADMIN_TOKEN: GO_RAW }, (m) => logs.push(m));
    const list = await listTokens(conn.db, "");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, "env-admin");
    assert.equal(list[0]!.admin, true);

    await conn.db.execute(sql`truncate tokens`);
    logs.length = 0;
    await bootstrap(conn.db, {}, (m) => logs.push(m));
    assert.match(logs[0]!, /First start.*\n[\s\S]*stf_[0-9a-f]{48}/);
    await bootstrap(conn.db, {}, (m) => logs.push(m));
    assert.equal(logs.length, 1);
    assert.equal((await listTokens(conn.db, ""))[0]!.name, "admin");
  });

  test("role comes from the membership, not the token", async () => {
    const { raw } = await createToken(conn.db, "", "laptop", false);
    const auth = new TokenAuthenticator(conn.db);
    const before = await auth.authenticate(raw);
    assert.equal(before?.role, "member");
    await conn.db.update(memberships).set({ role: "admin" }).where(eq(memberships.userId, before!.userId));
    const after = await auth.authenticate(raw);
    assert.equal(after?.role, "admin");
    assert.equal(after?.admin, true);
    assert.equal((await listTokens(conn.db, ""))[0]!.admin, true);
    // A second token for the same user shares the role.
    const second = await createToken(conn.db, "", "desktop", { userId: before!.userId });
    assert.equal(second.info.admin, true);
    assert.equal((await auth.authenticate(second.raw))?.userId, before!.userId);
  });
});
