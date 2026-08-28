import { randomBytes } from "node:crypto";
import { and, asc, count, eq, or } from "drizzle-orm";
import type { Member } from "@stift/shared";
import type { Db } from "../db/client.js";
import { memberships, tokens, users, type Role } from "../db/schema.js";

/** Users of an org with their role and token count, oldest membership first. */
export async function listMembers(db: Db, orgId: string): Promise<Member[]> {
  const rows = await db
    .select({ user: users, role: memberships.role, createdAt: memberships.createdAt, tokens: count(tokens.id) })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(tokens, and(eq(tokens.userId, users.id), eq(tokens.orgId, memberships.orgId)))
    .where(eq(memberships.orgId, orgId))
    .groupBy(users.id, memberships.role, memberships.createdAt)
    .orderBy(asc(memberships.createdAt), asc(users.name));
  return rows.map((r) => member(r.user, r.role, r.createdAt, r.tokens));
}

/** A member by user id, or by name when the id does not match (names are
 *  what people type on the CLI; ids are what the API hands back). */
export async function findMember(db: Db, orgId: string, ref: string): Promise<Member | null> {
  const all = await listMembers(db, orgId);
  return all.find((m) => m.id === ref) ?? all.find((m) => m.name === ref) ?? null;
}

export async function memberByName(db: Db, orgId: string, name: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), or(eq(users.name, name), eq(users.id, name))));
  return row ?? null;
}

/** Creates a user and its membership. Names are unique within an org. */
export async function addMember(db: Db, orgId: string, input: { name: string; email?: string; role: Role }): Promise<Member> {
  if (await memberByName(db, orgId, input.name)) throw new MemberExistsError(input.name);
  const id = randomBytes(8).toString("hex");
  return db.transaction(async (tx) => {
    const [u] = await tx.insert(users).values({ id, name: input.name, email: input.email ?? null }).returning();
    const [m] = await tx.insert(memberships).values({ orgId, userId: id, role: input.role }).returning();
    return member(u!, m!.role, m!.createdAt, 0);
  });
}

export async function setRole(db: Db, orgId: string, userId: string, role: Role) {
  const rows = await db
    .update(memberships)
    .set({ role })
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .returning();
  return rows.length > 0;
}

/** Removes the membership and the member's tokens in this org. The user row
 *  stays (sessions and bundles reference it); it is deleted when it holds no
 *  other membership. */
export async function removeMember(db: Db, orgId: string, userId: string) {
  return db.transaction(async (tx) => {
    const rows = await tx.delete(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId))).returning();
    if (rows.length === 0) return false;
    await tx.delete(tokens).where(and(eq(tokens.orgId, orgId), eq(tokens.userId, userId)));
    const [other] = await tx.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, userId)).limit(1);
    if (!other) await tx.delete(users).where(eq(users.id, userId));
    return true;
  });
}

export async function countAdmins(db: Db, orgId: string) {
  const [r] = await db
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "admin")));
  return r?.n ?? 0;
}

export class MemberExistsError extends Error {
  constructor(name: string) {
    super(`user ${JSON.stringify(name)} already exists`);
  }
}

const member = (u: typeof users.$inferSelect, role: Role, createdAt: Date, tokenCount: number): Member => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role,
  created_at: createdAt.toISOString(),
  tokens: tokenCount,
});
