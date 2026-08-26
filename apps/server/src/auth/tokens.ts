import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { TokenInfo } from "@stift/shared";
import type { Db } from "../db/client.js";
import { tokens } from "../db/schema.js";
import type { Authenticator } from "./authenticator.js";
import type { Identity } from "./identity.js";

/** Marks stift access tokens so they are recognizable in configs and secret
 *  scanners. Format and hashing are byte-compatible with the Go server. */
export const TOKEN_PREFIX = "stf_";

export const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

type Row = typeof tokens.$inferSelect;
const info = (r: Row): TokenInfo => ({
  id: r.id,
  name: r.name,
  admin: r.admin,
  created_at: r.createdAt.toISOString(),
  last_used_at: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
});

/** Mints a new token; the raw secret is returned exactly once. */
export async function createToken(db: Db, tenant: string, name: string, admin: boolean) {
  const raw = TOKEN_PREFIX + randomBytes(24).toString("hex");
  return { raw, info: await registerToken(db, tenant, raw, name, admin) };
}

/** Adds a known raw token (e.g. from STIFT_ADMIN_TOKEN). Idempotent on hash. */
export async function registerToken(db: Db, tenant: string, raw: string, name: string, admin: boolean) {
  const hash = hashToken(raw);
  const existing = await db.query.tokens.findFirst({ where: eq(tokens.hash, hash) });
  if (existing) return info(existing);
  const [row] = await db
    .insert(tokens)
    .values({ id: randomBytes(4).toString("hex"), tenant, name, hash, admin })
    .onConflictDoNothing()
    .returning();
  if (row) return info(row);
  return info((await db.query.tokens.findFirst({ where: eq(tokens.hash, hash) }))!);
}

export async function listTokens(db: Db, tenant: string): Promise<TokenInfo[]> {
  const rows = await db.query.tokens.findMany({ where: eq(tokens.tenant, tenant), orderBy: tokens.createdAt });
  return rows.map(info);
}

/** Returns false when no token with that id exists in the tenant. */
export async function revokeToken(db: Db, tenant: string, id: string) {
  const rows = await db.delete(tokens).where(and(eq(tokens.tenant, tenant), eq(tokens.id, id))).returning();
  return rows.length > 0;
}

export async function hasTokens(db: Db, tenant: string) {
  return (await db.query.tokens.findFirst({ where: eq(tokens.tenant, tenant) })) !== undefined;
}

/** Local-token authenticator over the `tokens` table. */
export class TokenAuthenticator implements Authenticator {
  constructor(private db: Db) {}

  async authenticate(raw: string): Promise<Identity | null> {
    if (!raw.startsWith(TOKEN_PREFIX)) return null;
    const hash = hashToken(raw);
    const row = await this.db.query.tokens.findFirst({ where: eq(tokens.hash, hash) });
    if (!row || !timingSafeEqual(Buffer.from(row.hash), Buffer.from(hash))) return null;
    // Fire-and-forget, coarse (once a minute) so a chatty daemon does not
    // write a row per request; errors must never fail the request.
    void this.db
      .update(tokens)
      .set({ lastUsedAt: sql`now()` })
      .where(and(eq(tokens.id, row.id), sql`(${tokens.lastUsedAt} is null or ${tokens.lastUsedAt} < now() - interval '1 minute')`))
      .catch(() => {});
    return { id: row.id, tenant: row.tenant, name: row.name, admin: row.admin };
  }
}
