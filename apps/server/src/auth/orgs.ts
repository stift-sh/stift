import { and, count, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { orgs, publishedSkills } from "../db/schema.js";
import { validSlug } from "../storage/validate.js";

export class SlugError extends Error {}
export class SlugTakenError extends Error {}
export class SlugLockedError extends Error {}

/** Published skills pin the slug (`@<slug>/<name>` must keep resolving).
 *  Hidden skills count too: their versions still resolve by number. */
export async function publishedCount(db: Pick<Db, "select">, orgId: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(publishedSkills).where(eq(publishedSkills.orgId, orgId));
  return r?.n ?? 0;
}

/** Renames the org and/or moves it to another slug. Returns false when the
 *  org does not exist. */
export async function updateOrg(db: Db, orgId: string, patch: { name?: string; slug?: string }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [org] = await tx.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, orgId)).for("update");
    if (!org) return false;
    const set: { name?: string; slug?: string } = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.slug !== undefined && patch.slug !== org.slug) {
      if (!validSlug(patch.slug)) throw new SlugError("invalid slug (want 2-39 lowercase letters, digits or hyphens, not starting with a hyphen)");
      const published = await publishedCount(tx, orgId);
      if (published > 0) throw new SlugLockedError(`slug is locked: ${published} published skills`);
      const [taken] = await tx.select({ id: orgs.id }).from(orgs).where(and(eq(orgs.slug, patch.slug), ne(orgs.id, orgId)));
      if (taken) throw new SlugTakenError(`slug "${patch.slug}" is taken`);
      set.slug = patch.slug;
    }
    if (Object.keys(set).length > 0) await tx.update(orgs).set(set).where(eq(orgs.id, orgId));
    return true;
  });
}
