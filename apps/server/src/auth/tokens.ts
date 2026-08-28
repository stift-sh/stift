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
type UserRow = { id: string; name: string };
const info = (r: Row, role: Role, user: UserRow): TokenInfo => ({
  id: r.id,
  name: r.name,
  admin: role === "admin",
  created_at: r.createdAt.toISOString(),
  last_used_at: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
  user,
});

const tokenJoin = (db: Pick<Db, "select">) =>
  db
    .select({ token: tokens, role: memberships.role, user: { id: users.id, name: users.name } })
    .from(tokens)
    .innerJoin(users, eq(users.id, tokens.userId))
    .leftJoin(memberships, and(eq(memberships.orgId, tokens.orgId), eq(memberships.userId, tokens.userId)));

/** Who a token belongs to: an existing user (the caller, normally) or a new
 *  user minted with it. New users come from the bootstrap (`env-admin`,
 *  `admin`) and from tests; the members API (skills-registry-3 item 3) is
 *  how further users appear. A boolean is shorthand for a new user with
 *  that admin-ness. */
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
  const [existing] = await tokenJoin(db).where(eq(tokens.hash, hash));
  if (existing) return info(existing.token, existing.role ?? "member", existing.user);
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
    const [r] = await tokenJoin(tx).where(eq(tokens.hash, row?.hash ?? hash));
    return info(r!.token, r!.role ?? "member", r!.user);
  });
}


/** Tokens of an org, or of one user in it when `userId` is given. */
export async function listTokens(db: Db, orgId: string, userId?: string): Promise<TokenInfo[]> {
  const conds = [eq(tokens.orgId, orgId)];
  if (userId !== undefined) conds.push(eq(tokens.userId, userId));
  const rows = await tokenJoin(db).where(and(...conds)).orderBy(tokens.createdAt);
  return rows.map((r) => info(r.token, r.role ?? "member", r.user));
}

/** Returns false when no matching token exists in the org (or, with
 *  `userId`, none owned by that user). */
export async function revokeToken(db: Db, orgId: string, id: string, userId?: string) {
  const conds = [eq(tokens.orgId, orgId), eq(tokens.id, id)];
  if (userId !== undefined) conds.push(eq(tokens.userId, userId));
  const rows = await db.delete(tokens).where(and(...conds)).returning();
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
    const [row] = await tokenJoin(this.db).where(eq(tokens.hash, hash));
    if (!row || !timingSafeEqual(Buffer.from(row.token.hash), Buffer.from(hash))) return null;
    // Fire-and-forget, coarse (once a minute) so a chatty daemon does not
    // write a row per request; errors must never fail the request.
    void this.db
      .update(tokens)
      .set({ lastUsedAt: sql`now()` })
      .where(and(eq(tokens.id, row.token.id), sql`(${tokens.lastUsedAt} is null or ${tokens.lastUsedAt} < now() - interval '1 minute')`))
      .catch(() => {});
    const t = row.token;
    return identity({ id: t.id, userId: t.userId, userName: row.user.name, orgId: t.orgId, name: t.name, role: row.role ?? "member" });
  }
}
