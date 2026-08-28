import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { TokenInfo } from "@stift/shared";
import type { Db } from "../db/client.js";
import { memberships, tokens, users, type Role } from "../db/schema.js";
import type { Authenticator } from "./authenticator.js";
import { identity, type Identity } from "./identity.js";

/** Marks stift access tokens so they are recognizable in configs and secret
 *  scanners. Format and hashing are byte-compatible with the Go server. */
export const TOKEN_PREFIX = "stf_";

export const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

type Row = typeof tokens.$inferSelect;
const info = (r: Row, role: Role): TokenInfo => ({
  id: r.id,
  name: r.name,
  admin: role === "admin",
  created_at: r.createdAt.toISOString(),
  last_used_at: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
});

/** Who a token belongs to. Until the members API lands (skills-registry-3
 *  item 3) every token gets a user of its own, named after the token, so the
 *  `admin` flag on the token API keeps working: it becomes the role of that
 *  user's membership. */
export type TokenOwner = { userId: string } | { newUser: { name: string; role: Role; email?: string } };

/** Mints a new token; the raw secret is returned exactly once. */
export async function createToken(db: Db, orgId: string, name: string, owner: TokenOwner | boolean) {
  const raw = TOKEN_PREFIX + randomBytes(24).toString("hex");
  return { raw, info: await registerToken(db, orgId, raw, name, owner) };
}

/** Adds a known raw token (e.g. from STIFT_ADMIN_TOKEN). Idempotent on hash.
 *  A boolean owner is shorthand for a new user with that admin-ness. */
export async function registerToken(db: Db, orgId: string, raw: string, name: string, owner: TokenOwner | boolean) {
  const hash = hashToken(raw);
  const existing = await db.query.tokens.findFirst({ where: eq(tokens.hash, hash) });
  if (existing) return info(existing, await roleOf(db, existing.orgId, existing.userId));
  const o: TokenOwner = typeof owner === "boolean" ? { newUser: { name, role: owner ? "admin" : "member" } } : owner;
  return db.transaction(async (tx) => {
    let userId: string;
    if ("userId" in o) {
      userId = o.userId;
    } else {
      userId = randomBytes(8).toString("hex");
      await tx.insert(users).values({ id: userId, name: o.newUser.name, email: o.newUser.email ?? null });
      await tx.insert(memberships).values({ orgId, userId, role: o.newUser.role });
    }
    const [row] = await tx
      .insert(tokens)
      .values({ id: randomBytes(4).toString("hex"), orgId, userId, name, hash })
      .onConflictDoNothing()
      .returning();
    if (row) return info(row, await roleOf(tx, orgId, userId));
    const r = (await tx.query.tokens.findFirst({ where: eq(tokens.hash, hash) }))!;
    return info(r, await roleOf(tx, r.orgId, r.userId));
  });
}

/** Role of a user in an org; "member" when no membership exists. */
export async function roleOf(db: Pick<Db, "query">, orgId: string, userId: string): Promise<Role> {
  const m = await db.query.memberships.findFirst({
    where: and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)),
  });
  return m?.role ?? "member";
}

export async function listTokens(db: Db, orgId: string): Promise<TokenInfo[]> {
  const rows = await db
    .select({ token: tokens, role: memberships.role })
    .from(tokens)
    .leftJoin(memberships, and(eq(memberships.orgId, tokens.orgId), eq(memberships.userId, tokens.userId)))
    .where(eq(tokens.orgId, orgId))
    .orderBy(tokens.createdAt);
  return rows.map((r) => info(r.token, r.role ?? "member"));
}

/** Returns false when no token with that id exists in the org. */
export async function revokeToken(db: Db, orgId: string, id: string) {
  const rows = await db.delete(tokens).where(and(eq(tokens.orgId, orgId), eq(tokens.id, id))).returning();
  return rows.length > 0;
}

export async function hasTokens(db: Db, orgId: string) {
  return (await db.query.tokens.findFirst({ where: eq(tokens.orgId, orgId) })) !== undefined;
}

/** Local-token authenticator over the `tokens` table. The role is read from
 *  the membership on every request so a role change applies at once. */
export class TokenAuthenticator implements Authenticator {
  constructor(private db: Db) {}

  async authenticate(raw: string): Promise<Identity | null> {
    if (!raw.startsWith(TOKEN_PREFIX)) return null;
    const hash = hashToken(raw);
    const [row] = await this.db
      .select({ token: tokens, role: memberships.role })
      .from(tokens)
      .leftJoin(memberships, and(eq(memberships.orgId, tokens.orgId), eq(memberships.userId, tokens.userId)))
      .where(eq(tokens.hash, hash));
    if (!row || !timingSafeEqual(Buffer.from(row.token.hash), Buffer.from(hash))) return null;
    // Fire-and-forget, coarse (once a minute) so a chatty daemon does not
    // write a row per request; errors must never fail the request.
    void this.db
      .update(tokens)
      .set({ lastUsedAt: sql`now()` })
      .where(and(eq(tokens.id, row.token.id), sql`(${tokens.lastUsedAt} is null or ${tokens.lastUsedAt} < now() - interval '1 minute')`))
      .catch(() => {});
    const t = row.token;
    return identity({ id: t.id, userId: t.userId, orgId: t.orgId, name: t.name, role: row.role ?? "member" });
  }
}
