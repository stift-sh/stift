// The public registry (skills-registry-4, item 3): read-only views over
// published skills that need no token. Search and `latest` show only visible
// rows; a version asked for by number keeps resolving after unpublish so an
// existing install can still verify itself.
import { and, desc, eq, gt, ilike, isNull, lt, or, sql } from "drizzle-orm";
import type { PublishedSkill, RegistrySearch, RegistrySkill } from "@stift/shared";
import type { Db } from "../db/client.js";
import { orgs, publishedSkills, publishedVersions, users } from "../db/schema.js";
import { NotFoundError } from "./errors.js";
import { toSkill, toVersion } from "./published.js";
import { validSha, validSlug } from "./validate.js";

export type SearchInput = { q?: string; limit?: number; cursor?: string };

export const SEARCH_LIMIT = 50;

/** Search results are ordered by (updated_at desc, id desc); the cursor is
 *  that pair of the last row, opaque to clients. */
function encodeCursor(updatedAt: Date, id: number): string {
  return Buffer.from(`${updatedAt.getTime()}:${id}`).toString("base64url");
}
function decodeCursor(s: string): { updatedAt: Date; id: number } | null {
  const m = /^(\d+):(\d+)$/.exec(Buffer.from(s, "base64url").toString());
  if (!m) return null;
  return { updatedAt: new Date(Number(m[1])), id: Number(m[2]) };
}

/** Rows the registry lists: not hidden and with at least one visible version. */
const visible = and(isNull(publishedSkills.unpublishedAt), gt(publishedSkills.latest, 0));

/** ILIKE over name, description and org slug, newest first. Ranking and
 *  download counts are the cloud index's job (ADR 0001 step 5). */
export async function searchPublished(db: Db, input: SearchInput): Promise<RegistrySearch> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), SEARCH_LIMIT);
  const q = input.q?.trim();
  const conds = [visible];
  if (q) {
    const pat = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    conds.push(or(ilike(publishedSkills.name, pat), ilike(publishedSkills.description, pat), ilike(orgs.slug, pat))!);
  }
  if (input.cursor) {
    const c = decodeCursor(input.cursor);
    if (!c) return { skills: [], next: null };
    conds.push(
      or(
        lt(publishedSkills.updatedAt, c.updatedAt),
        and(eq(publishedSkills.updatedAt, c.updatedAt), lt(publishedSkills.id, c.id)),
      )!,
    );
  }
  const rows = await db
    .select({ s: publishedSkills, slug: orgs.slug })
    .from(publishedSkills)
    .innerJoin(orgs, eq(orgs.id, publishedSkills.orgId))
    .where(and(...conds))
    .orderBy(desc(publishedSkills.updatedAt), desc(publishedSkills.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    skills: page.map((r) => toSkill(r.slug, r.s)),
    next: rows.length > limit && last ? encodeCursor(last.s.updatedAt, last.s.id) : null,
  };
}

async function skillByRef(db: Db, org: string, name: string) {
  if (!validSlug(org) || !validSlug(name)) return undefined;
  const [row] = await db
    .select({ s: publishedSkills, slug: orgs.slug })
    .from(publishedSkills)
    .innerJoin(orgs, eq(orgs.id, publishedSkills.orgId))
    .where(and(eq(orgs.slug, org), eq(publishedSkills.name, name)));
  return row;
}

async function versionRow(db: Db, skillId: number, version: number) {
  const [row] = await db
    .select({ v: publishedVersions, by: { id: users.id, name: users.name } })
    .from(publishedVersions)
    .leftJoin(users, eq(users.id, publishedVersions.publishedBy))
    .where(and(eq(publishedVersions.skillId, skillId), eq(publishedVersions.version, version)));
  return row;
}

/**
 * `@<org>/<name>` with `version` absent resolves `latest` and 404s while the
 * skill is hidden or has no visible version; with a number it resolves any
 * published version, hidden or not (the body says so via `unpublished_at`).
 */
export async function getPublished(db: Db, org: string, name: string, version?: number): Promise<RegistrySkill> {
  const ref = `@${org}/${name}${version ? `@${version}` : ""}`;
  const row = await skillByRef(db, org, name);
  if (!row) throw new NotFoundError(`${ref} is not published`);
  const skill: PublishedSkill = toSkill(row.slug, row.s);
  if (version === undefined) {
    if (skill.unpublished_at || skill.latest === 0) throw new NotFoundError(`${ref} is not published`);
    version = skill.latest;
  }
  const v = await versionRow(db, row.s.id, version);
  if (!v) throw new NotFoundError(`${ref} is not published`);
  return { skill, version: toVersion(row.slug, row.s.name, v.v, v.by) };
}

/**
 * The org id that stores `sha`, but only when the digest is in that
 * published version's manifest: the public blob route must not be an
 * oracle for the org's private blobs.
 */
export async function publishedBlobOrg(db: Db, org: string, name: string, version: number, sha: string): Promise<string> {
  if (!validSha(sha)) throw new NotFoundError("blob not found");
  const row = await skillByRef(db, org, name);
  if (!row) throw new NotFoundError("blob not found");
  const [v] = await db
    .select({ n: sql<number>`1` })
    .from(publishedVersions)
    .where(
      and(
        eq(publishedVersions.skillId, row.s.id),
        eq(publishedVersions.version, version),
        sql`exists (select 1 from jsonb_array_elements(${publishedVersions.manifest}->'files') f where f->>'sha256' = ${sha})`,
      ),
    );
  if (!v) throw new NotFoundError("blob not found");
  return row.s.orgId;
}
