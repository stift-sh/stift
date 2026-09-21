import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Db } from "../db/client.js";
import { memberships, orgs, users, type Role } from "../db/schema.js";
import { validSlug } from "../storage/validate.js";
import type { Authenticator } from "./authenticator.js";
import type { Identity } from "./identity.js";

export type JwtClaims = { org: string; orgSlug: string; orgName: string; role: string; name: string; email: string };

export type JwtConfig = {
  /** Verification key: a JWKS URL (asymmetric) or a shared secret (HS256). */
  jwksUrl?: string;
  secret?: string;
  issuer?: string;
  audience?: string;
  /** Pins every token to this org and ignores the org claims: "" for a
   *  single-org self-host behind an OIDC provider. Unset = multi-org. */
  org?: string;
  claims: JwtClaims;
  /** How long a provisioned (user, org, role) is trusted without touching the db. */
  cacheMs: number;
};

const DEFAULT_CLAIMS: JwtClaims = { org: "org_id", orgSlug: "org_slug", orgName: "org_name", role: "org_role", name: "name", email: "email" };

/** STIFT_JWT_JWKS_URL or STIFT_JWT_SECRET (exactly one), STIFT_JWT_ISSUER,
 *  STIFT_JWT_AUDIENCE, STIFT_JWT_ORG, and STIFT_JWT_CLAIM_{ORG,ORG_SLUG,
 *  ORG_NAME,ROLE,NAME,EMAIL} to read claims under other names. */
export function jwtConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JwtConfig {
  const jwksUrl = env.STIFT_JWT_JWKS_URL || undefined;
  const secret = env.STIFT_JWT_SECRET || undefined;
  if (!jwksUrl === !secret) throw new Error("STIFT_AUTH=jwt: set exactly one of STIFT_JWT_JWKS_URL and STIFT_JWT_SECRET");
  if (jwksUrl && !env.STIFT_JWT_ISSUER) throw new Error("STIFT_JWT_ISSUER is required with STIFT_JWT_JWKS_URL");
  if (secret && secret.length < 32) throw new Error("STIFT_JWT_SECRET: want at least 32 characters");
  return {
    jwksUrl,
    secret,
    issuer: env.STIFT_JWT_ISSUER || undefined,
    audience: env.STIFT_JWT_AUDIENCE || undefined,
    org: env.STIFT_JWT_ORG,
    claims: {
      org: env.STIFT_JWT_CLAIM_ORG || DEFAULT_CLAIMS.org,
      orgSlug: env.STIFT_JWT_CLAIM_ORG_SLUG || DEFAULT_CLAIMS.orgSlug,
      orgName: env.STIFT_JWT_CLAIM_ORG_NAME || DEFAULT_CLAIMS.orgName,
      role: env.STIFT_JWT_CLAIM_ROLE || DEFAULT_CLAIMS.role,
      name: env.STIFT_JWT_CLAIM_NAME || DEFAULT_CLAIMS.name,
      email: env.STIFT_JWT_CLAIM_EMAIL || DEFAULT_CLAIMS.email,
    },
    cacheMs: 60_000,
  };
}

/** `admin` and provider spellings of it (`org:admin`, `owner`) are admins,
 *  any other value is a member. Null without a role claim: the provider
 *  does not manage roles, so the membership's own role stands. */
export function mapRole(claim: unknown): Role | null {
  if (typeof claim !== "string" || !claim) return null;
  const r = claim.toLowerCase().replace(/^org:/, "");
  return r === "admin" || r === "owner" ? "admin" : "member";
}

const str = (p: JWTPayload, claim: string) => (typeof p[claim] === "string" ? (p[claim] as string).trim() : "");

/** Verifies JWTs from an identity provider and provisions what they name:
 *  the org, the user and the membership are upserted on first sight, so the
 *  provider stays the source of truth and nothing has to be created here
 *  first. A role claim overwrites the membership's role; without one, new
 *  members start as `member` and admins are made through the API. Seats are
 *  not checked (the provider decides who is a member); a
 *  removed member is dropped through the API, a JWT cannot say so. */
export class JwtAuthenticator implements Authenticator {
  private key: JWTVerifyGetKey | Uint8Array;
  private seen = new Map<string, { until: number; role: Role }>();

  constructor(
    private db: Db,
    private cfg: JwtConfig,
    private now = Date.now,
  ) {
    this.key = cfg.jwksUrl ? createRemoteJWKSet(new URL(cfg.jwksUrl)) : new TextEncoder().encode(cfg.secret!);
  }

  async authenticate(raw: string): Promise<Identity | null> {
    // Three dot-separated parts or it is someone else's token (`stf_…`).
    if (raw.split(".").length !== 3) return null;
    let p: JWTPayload;
    try {
      const opts = { issuer: this.cfg.issuer, audience: this.cfg.audience, algorithms: this.cfg.secret ? ["HS256"] : undefined, clockTolerance: 5 };
      p = (await jwtVerify(raw, this.key as JWTVerifyGetKey, opts)).payload;
    } catch {
      return null;
    }
    if (!p.sub || !p.exp) return null;
    const pinned = this.cfg.org !== undefined;
    const orgId = pinned ? this.cfg.org! : str(p, this.cfg.claims.org);
    // No org selected at the provider: the server has no personal tenant.
    if (!pinned && !orgId) return null;
    const claimed = mapRole(p[this.cfg.claims.role]);
    const email = str(p, this.cfg.claims.email);
    const userName = str(p, this.cfg.claims.name) || email || p.sub;
    const orgName = str(p, this.cfg.claims.orgName);
    const orgSlug = str(p, this.cfg.claims.orgSlug);

    const key = [p.sub, orgId, claimed ?? "", userName, orgName].join("\0");
    let hit = this.seen.get(key);
    if (!hit || hit.until <= this.now()) {
      const role = await this.provision({ userId: p.sub, userName, email, orgId, orgName, orgSlug, role: claimed, pinned });
      if (this.seen.size > 10_000) this.seen.clear();
      hit = { until: this.now() + this.cfg.cacheMs, role };
      this.seen.set(key, hit);
    }
    return { id: `jwt:${p.sub}`, userId: p.sub, userName, orgId, name: "jwt", role: hit.role };
  }

  private async provision(v: { userId: string; userName: string; email: string; orgId: string; orgName: string; orgSlug: string; role: Role | null; pinned: boolean }): Promise<Role> {
    return this.db.transaction(async (tx) => {
      if (!v.pinned) {
        const [org] = await tx.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, v.orgId));
        if (!org) {
          // The slug is taken from the claim once; after that it is the org's
          // to change (PATCH /v1/org) and may be locked by published skills.
          const fallback = `org-${createHash("sha256").update(v.orgId).digest("hex").slice(0, 12)}`;
          let slug = validSlug(v.orgSlug) && v.orgSlug !== "default" ? v.orgSlug : fallback;
          if (slug !== fallback && (await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.slug, slug))).length > 0) slug = fallback;
          await tx.insert(orgs).values({ id: v.orgId, slug, name: v.orgName || slug }).onConflictDoNothing();
        } else if (v.orgName && org.name !== v.orgName) {
          await tx.update(orgs).set({ name: v.orgName }).where(eq(orgs.id, v.orgId));
        }
      }
      await tx
        .insert(users)
        .values({ id: v.userId, name: v.userName, email: v.email || null })
        .onConflictDoUpdate({ target: users.id, set: { name: v.userName, ...(v.email ? { email: v.email } : {}) } });
      const insert = tx.insert(memberships).values({ orgId: v.orgId, userId: v.userId, role: v.role ?? "member" });
      if (v.role) {
        await insert.onConflictDoUpdate({ target: [memberships.orgId, memberships.userId], set: { role: v.role } });
        return v.role;
      }
      await insert.onConflictDoNothing();
      const [m] = await tx.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.orgId, v.orgId), eq(memberships.userId, v.userId)));
      return m!.role;
    });
  }
}
