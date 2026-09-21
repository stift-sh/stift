import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { connect, runMigrations } from "../db/client.js";
import { memberships, orgs, users } from "../db/schema.js";
import { ensureDefaultOrg } from "./bootstrap.js";
import { authFromEnv } from "./config.js";
import { JwtAuthenticator, jwtConfigFromEnv, mapRole, type JwtConfig } from "./jwt.js";
import { setRole } from "./members.js";
import { createToken } from "./tokens.js";

const dbUrl = process.env.STIFT_TEST_DATABASE_URL;
const SECRET = "0123456789abcdef0123456789abcdef";
const ISS = "https://idp.test";

test("mapRole", () => {
  assert.equal(mapRole("org:admin"), "admin");
  assert.equal(mapRole("Owner"), "admin");
  assert.equal(mapRole("org:member"), "member");
  assert.equal(mapRole("viewer"), "member");
  assert.equal(mapRole(undefined), null);
  assert.equal(mapRole(""), null);
});

test("jwtConfigFromEnv", () => {
  assert.throws(() => jwtConfigFromEnv({}), /exactly one/);
  assert.throws(() => jwtConfigFromEnv({ STIFT_JWT_SECRET: SECRET, STIFT_JWT_JWKS_URL: "https://x/jwks" }), /exactly one/);
  assert.throws(() => jwtConfigFromEnv({ STIFT_JWT_JWKS_URL: "https://x/jwks" }), /STIFT_JWT_ISSUER/);
  assert.throws(() => jwtConfigFromEnv({ STIFT_JWT_SECRET: "short" }), /32 characters/);
  const cfg = jwtConfigFromEnv({ STIFT_JWT_SECRET: SECRET, STIFT_JWT_CLAIM_ORG: "o", STIFT_JWT_ORG: "" });
  assert.equal(cfg.claims.org, "o");
  assert.equal(cfg.claims.role, "org_role");
  assert.equal(cfg.org, "");
  assert.equal(jwtConfigFromEnv({ STIFT_JWT_SECRET: SECRET }).org, undefined);
});

describe("jwt authenticator", { skip: dbUrl ? false : "STIFT_TEST_DATABASE_URL not set" }, () => {
  let conn: ReturnType<typeof connect>;
  const base: JwtConfig = { ...jwtConfigFromEnv({ STIFT_JWT_SECRET: SECRET, STIFT_JWT_ISSUER: ISS, STIFT_JWT_AUDIENCE: "stift" }), cacheMs: 0 };
  const key = new TextEncoder().encode(SECRET);
  const claims = { org_id: "org_acme", org_slug: "acme", org_name: "Acme", org_role: "org:admin", name: "Ada", email: "ada@acme.test" };
  const sign = (c: Record<string, unknown> = claims, o: { sub?: string; iss?: string; aud?: string; exp?: string | number; key?: Uint8Array } = {}) =>
    new SignJWT(c)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(o.sub ?? "user_ada")
      .setIssuer(o.iss ?? ISS)
      .setAudience(o.aud ?? "stift")
      .setExpirationTime(o.exp ?? "5m")
      .sign(o.key ?? key);

  before(async () => {
    conn = connect(dbUrl!);
    await runMigrations(conn.db);
  });
  beforeEach(async () => {
    await conn.db.execute(sql`truncate tokens, memberships, users cascade`);
    await conn.db.execute(sql`delete from orgs where id <> ''`);
    await ensureDefaultOrg(conn.db, {});
  });
  after(() => conn.pool.end());

  test("provisions org, user and membership on first sight", async () => {
    const auth = new JwtAuthenticator(conn.db, base);
    const id = await auth.authenticate(await sign());
    assert.deepEqual(id, { id: "jwt:user_ada", userId: "user_ada", userName: "Ada", orgId: "org_acme", name: "jwt", role: "admin" });
    const [org] = await conn.db.select().from(orgs).where(eq(orgs.id, "org_acme"));
    assert.equal(org?.slug, "acme");
    assert.equal(org?.name, "Acme");
    const [u] = await conn.db.select().from(users).where(eq(users.id, "user_ada"));
    assert.equal(u?.email, "ada@acme.test");
    // Idempotent, and a second user joins the same org.
    await auth.authenticate(await sign());
    await auth.authenticate(await sign({ ...claims, org_role: "org:member", name: "Bo" }, { sub: "user_bo" }));
    const ms = await conn.db.select().from(memberships).where(eq(memberships.orgId, "org_acme"));
    assert.deepEqual(ms.map((m) => [m.userId, m.role]).sort(), [["user_ada", "admin"], ["user_bo", "member"]]);
  });

  test("rejects bad signature, issuer, audience, expiry, alg and shape", async () => {
    const auth = new JwtAuthenticator(conn.db, base);
    assert.equal(await auth.authenticate(await sign(claims, { key: new TextEncoder().encode("x".repeat(32)) })), null);
    assert.equal(await auth.authenticate(await sign(claims, { iss: "https://evil.test" })), null);
    assert.equal(await auth.authenticate(await sign(claims, { aud: "other" })), null);
    assert.equal(await auth.authenticate(await sign(claims, { exp: Math.floor(Date.now() / 1000) - 60 })), null);
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "user_ada", iss: ISS, aud: "stift", exp: 9e9, ...claims })).toString("base64url")}.`;
    assert.equal(await auth.authenticate(none), null);
    assert.equal(await auth.authenticate("stf_" + "0".repeat(48)), null);
    const noExp = await new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setSubject("user_ada").setIssuer(ISS).setAudience("stift").sign(key);
    assert.equal(await auth.authenticate(noExp), null);
    assert.equal((await conn.db.select().from(users)).length, 0);
  });

  test("no org claim is rejected; the default org is unreachable in multi-org mode", async () => {
    const auth = new JwtAuthenticator(conn.db, base);
    const { org_id: _, ...rest } = claims;
    assert.equal(await auth.authenticate(await sign(rest)), null);
    assert.equal(await auth.authenticate(await sign({ ...claims, org_id: "" })), null);
    assert.equal((await conn.db.select().from(memberships)).length, 0);
  });

  test("role claim follows the provider; org name follows, slug does not", async () => {
    const auth = new JwtAuthenticator(conn.db, base);
    await auth.authenticate(await sign());
    const id = await auth.authenticate(await sign({ ...claims, org_role: "org:member", org_name: "Acme Inc", org_slug: "acme-inc" }));
    assert.equal(id?.role, "member");
    const [org] = await conn.db.select().from(orgs).where(eq(orgs.id, "org_acme"));
    assert.equal(org?.name, "Acme Inc");
    assert.equal(org?.slug, "acme");
  });

  test("invalid, reserved or taken slugs fall back to a derived one", async () => {
    const auth = new JwtAuthenticator(conn.db, base);
    await auth.authenticate(await sign());
    await auth.authenticate(await sign({ ...claims, org_id: "org_2" }));
    await auth.authenticate(await sign({ ...claims, org_id: "org_3", org_slug: "Not Valid" }));
    await auth.authenticate(await sign({ ...claims, org_id: "org_4", org_slug: "default" }));
    for (const id of ["org_2", "org_3", "org_4"]) {
      const [org] = await conn.db.select().from(orgs).where(eq(orgs.id, id));
      assert.match(org!.slug, /^org-[0-9a-f]{12}$/);
    }
  });

  test("provisioning is cached for cacheMs", async () => {
    let now = 1_000;
    const auth = new JwtAuthenticator(conn.db, { ...base, cacheMs: 60_000 }, () => now);
    const raw = await sign();
    await auth.authenticate(raw);
    await conn.db.delete(memberships).where(eq(memberships.userId, "user_ada"));
    await auth.authenticate(raw);
    assert.equal((await conn.db.select().from(memberships)).length, 0);
    now += 60_001;
    await auth.authenticate(raw);
    assert.equal((await conn.db.select().from(memberships)).length, 1);
  });

  test("STIFT_JWT_ORG pins to the default org; without a role claim the local role stands", async () => {
    const auth = new JwtAuthenticator(conn.db, { ...base, org: "" });
    const { org_role: _, ...rest } = claims;
    const first = await auth.authenticate(await sign(rest));
    assert.equal(first?.orgId, "");
    assert.equal(first?.role, "member");
    assert.equal((await conn.db.select().from(orgs)).length, 1);
    await setRole(conn.db, "", "user_ada", "admin");
    assert.equal((await auth.authenticate(await sign(rest)))?.role, "admin");
    const [m] = await conn.db.select().from(memberships).where(and(eq(memberships.orgId, ""), eq(memberships.userId, "user_ada")));
    assert.equal(m?.role, "admin");
  });

  test("local,jwt chains: stf_ tokens and JWTs both resolve", async () => {
    const env = { STIFT_JWT_SECRET: SECRET, STIFT_JWT_ISSUER: ISS, STIFT_JWT_AUDIENCE: "stift" };
    const cfg = authFromEnv(conn.db, "local,jwt", env);
    assert.deepEqual([cfg.local, cfg.bootstrap], [true, false]);
    assert.deepEqual([authFromEnv(conn.db, "local,jwt", { ...env, STIFT_JWT_ORG: "" }).bootstrap, authFromEnv(conn.db, "jwt", env).local], [true, false]);
    assert.equal(authFromEnv(conn.db, "local", {}).bootstrap, true);
    assert.throws(() => authFromEnv(conn.db, "oidc", {}), /supported: local, jwt/);
    const { raw } = await createToken(conn.db, "", "ci", false);
    assert.equal((await cfg.authenticator.authenticate(raw))?.name, "ci");
    assert.equal((await cfg.authenticator.authenticate(await sign()))?.orgId, "org_acme");
  });

  describe("jwks", () => {
    let server: Server;
    let jwks: { keys: JWK[] } = { keys: [] };
    let hits = 0;
    let url = "";
    before(async () => {
      server = createServer((_, res) => {
        hits++;
        res.setHeader("content-type", "application/json").end(JSON.stringify(jwks));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`;
    });
    after(() => server.close());

    test("verifies RS256 against the JWKS and rejects a key it does not list", async () => {
      const a = await generateKeyPair("RS256");
      const b = await generateKeyPair("RS256");
      jwks = { keys: [{ ...(await exportJWK(a.publicKey)), kid: "a", alg: "RS256", use: "sig" }] };
      const auth = new JwtAuthenticator(conn.db, { ...base, secret: undefined, jwksUrl: url });
      const rs = (k: CryptoKey, kid: string) =>
        new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid }).setSubject("user_ada").setIssuer(ISS).setAudience("stift").setExpirationTime("5m").sign(k);
      assert.equal((await auth.authenticate(await rs(a.privateKey, "a")))?.userId, "user_ada");
      assert.equal(await auth.authenticate(await rs(b.privateKey, "a")), null);
      // An HS256 token signed with the public JWKS material must not pass.
      assert.equal(await auth.authenticate(await sign()), null);
      assert.ok(hits >= 1);
    });
  });
});
