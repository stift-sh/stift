// Public sharing (skills-registry-4, item 2): the org's published skills.
// Publishing copies the source manifest; nothing here references bundle
// rows, so the org unit can be edited, rolled back or deleted freely.
import { and, asc, desc, eq, max, sql } from "drizzle-orm";
import type { Bundle, PublishedSkill, PublishedSkillDetail, PublishedVersion } from "@stift/shared";
import type { Db } from "../db/client.js";
import { orgs, publishedSkills, publishedVersions, users, type PublishedManifest } from "../db/schema.js";
import { NotFoundError, PublishConflictError, PublishError } from "./errors.js";
import { validSlug } from "./validate.js";

/** What POST /v1/published asks for, validated by the route. */
export type PublishInput = {
  agent: string;
  /** Org-scope unit name, e.g. `skills/deploy`. */
  unit: string;
  /** Public name; default the unit's last segment. Fixed after the first publish. */
  name?: string;
  /** Required on the first publish; updates the skill afterwards. */
  license?: string;
  /** Source bundle version; default head. */
  version?: number;
  /** The publishing user, recorded on the version. */
  userId?: string;
};

/** SPDX identifiers (`MIT`, `Apache-2.0`, `GPL-3.0-or-later`) and
 *  `LicenseRef-<name>` share one charset; no list is maintained. */
export function validLicense(s: string): boolean {
  return /^[A-Za-z0-9.+-]{1,64}$/.test(s);
}

/** A transaction handle; every write here runs inside one. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type SkillRow = typeof publishedSkills.$inferSelect;
type VersionRow = typeof publishedVersions.$inferSelect;
type UserRef = { id: string; name: string } | null;

export function toSkill(slug: string, r: SkillRow): PublishedSkill {
  return {
    org: slug,
    name: r.name,
    agent: r.agent,
    unit: r.unit,
    description: r.description,
    license: r.license,
    latest: r.latest,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
    unpublished_at: r.unpublishedAt?.toISOString() ?? null,
  };
}

export function toVersion(slug: string, name: string, r: VersionRow, by: UserRef): PublishedVersion {
  return {
    org: slug,
    name,
    version: r.version,
    source_version: r.sourceVersion,
    files: r.manifest.files,
    skills: r.manifest.skills,
    readme_path: r.readmePath,
    ...(by ? { published_by: by } : {}),
    created_at: r.createdAt.toISOString(),
    unpublished_at: r.unpublishedAt?.toISOString() ?? null,
  };
}

/** Two manifests publish the same thing when their file lists match;
 *  `files` is sorted by path in every stored manifest. */
function sameFiles(a: PublishedManifest["files"], b: PublishedManifest["files"]): boolean {
  return a.length === b.length && a.every((f, i) => f.path === b[i]!.path && f.sha256 === b[i]!.sha256 && f.mode === b[i]!.mode);
}

/** The SKILL.md the README renders from: the shallowest one, then by path. */
function readmeOf(b: Bundle): string | undefined {
  const paths = b.files.map((f) => f.path).filter((p) => p.split("/").pop() === "SKILL.md");
  paths.sort((x, y) => x.split("/").length - y.split("/").length || (x < y ? -1 : x > y ? 1 : 0));
  return paths[0];
}

/** Newest visible version, 0 when every version is hidden. */
async function recomputeLatest(tx: Tx, skillId: number) {
  const [r] = await tx
    .select({ latest: max(publishedVersions.version) })
    .from(publishedVersions)
    .where(and(eq(publishedVersions.skillId, skillId), sql`${publishedVersions.unpublishedAt} is null`));
  await tx.update(publishedSkills).set({ latest: r?.latest ?? 0, updatedAt: new Date() }).where(eq(publishedSkills.id, skillId));
}

/**
 * Publishes `source` (an org-scope bundle manifest the caller already
 * fetched) as `@<slug>/<name>`. The org row is locked so the slug cannot
 * change underneath, and the skill row so concurrent publishes number
 * versions in sequence.
 */
export async function publish(db: Db, orgId: string, source: Bundle, input: PublishInput): Promise<PublishedVersion> {
  if (source.scope !== "org") throw new PublishError("only org-scope units can be published");
  const readmePath = readmeOf(source);
  if (!readmePath) throw new PublishError(`${source.name} has no SKILL.md`);
  const name = input.name ?? source.name.split("/").pop()!;
  if (!validSlug(name)) throw new PublishError(`invalid name "${name}" (want 2-39 lowercase letters, digits or hyphens, not starting with a hyphen)`);
  if (input.license !== undefined && !validLicense(input.license)) {
    throw new PublishError(`invalid license "${input.license}" (want an SPDX identifier or LicenseRef-<name>)`);
  }
  const readme = source.skills.find((s) => s.path === readmePath);
  const manifest: PublishedManifest = { files: source.files, skills: source.skills };

  return db.transaction(async (tx) => {
    const [org] = await tx.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, orgId)).for("update");
    if (!org) throw new NotFoundError("no such org");
    if (org.slug === "default") throw new PublishError("set an org slug before publishing");

    let [skill] = await tx
      .select()
      .from(publishedSkills)
      .where(and(eq(publishedSkills.orgId, orgId), eq(publishedSkills.name, name)))
      .for("update");
    if (skill) {
      if (skill.unit !== source.name || skill.agent !== source.agent) {
        throw new PublishConflictError(`@${org.slug}/${name} is published from ${skill.agent} ${skill.unit}, not ${source.agent} ${source.name}`);
      }
      const dupes = await tx
        .select({ version: publishedVersions.version, manifest: publishedVersions.manifest })
        .from(publishedVersions)
        .where(eq(publishedVersions.skillId, skill.id));
      const dupe = dupes.find((v) => sameFiles(v.manifest.files, manifest.files));
      if (dupe) throw new PublishConflictError(`already published as version ${dupe.version}`);
    } else {
      if (input.license === undefined) throw new PublishError("license is required on the first publish");
      [skill] = await tx
        .insert(publishedSkills)
        .values({ orgId, name, agent: source.agent, unit: source.name, license: input.license })
        .returning();
    }
    const [last] = await tx
      .select({ n: max(publishedVersions.version) })
      .from(publishedVersions)
      .where(eq(publishedVersions.skillId, skill!.id));
    const now = new Date();
    const [row] = await tx
      .insert(publishedVersions)
      .values({
        skillId: skill!.id,
        version: (last?.n ?? 0) + 1,
        sourceVersion: source.version,
        manifest,
        readmePath,
        publishedBy: input.userId ?? null,
        createdAt: now,
      })
      .returning();
    // A new publish makes the skill visible again and refreshes what the
    // registry shows for it.
    await tx
      .update(publishedSkills)
      .set({
        description: readme?.description ?? "",
        ...(input.license !== undefined ? { license: input.license } : {}),
        latest: row!.version,
        unpublishedAt: null,
        updatedAt: now,
      })
      .where(eq(publishedSkills.id, skill!.id));
    const by = input.userId ? ((await tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, input.userId)))[0] ?? null) : null;
    return toVersion(org.slug, name, row!, by);
  });
}

async function skillRow(tx: Tx, orgId: string, name: string) {
  const [skill] = await tx
    .select()
    .from(publishedSkills)
    .where(and(eq(publishedSkills.orgId, orgId), eq(publishedSkills.name, name)))
    .for("update");
  if (!skill) throw new NotFoundError(`@…/${name} is not published`);
  return skill;
}

/** Hides one version, or the whole skill when `version` is absent. Hidden
 *  rows keep resolving by number; only search and `latest` forget them. */
export async function unpublish(db: Db, orgId: string, name: string, version?: number): Promise<void> {
  return setHidden(db, orgId, name, version, new Date());
}

/** Undoes `unpublish` for one version or the whole skill. */
export async function restore(db: Db, orgId: string, name: string, version?: number): Promise<void> {
  return setHidden(db, orgId, name, version, null);
}

async function setHidden(db: Db, orgId: string, name: string, version: number | undefined, at: Date | null) {
  await db.transaction(async (tx) => {
    const skill = await skillRow(tx, orgId, name);
    if (version === undefined) {
      await tx.update(publishedSkills).set({ unpublishedAt: at, updatedAt: new Date() }).where(eq(publishedSkills.id, skill.id));
      return;
    }
    const updated = await tx
      .update(publishedVersions)
      .set({ unpublishedAt: at })
      .where(and(eq(publishedVersions.skillId, skill.id), eq(publishedVersions.version, version)))
      .returning({ version: publishedVersions.version });
    if (updated.length === 0) throw new NotFoundError(`@…/${name} has no version ${version}`);
    await recomputeLatest(tx, skill.id);
  });
}

/** Every published skill of the org with its versions newest first, hidden
 *  ones included (this is the admin's view, not the registry's). */
export async function listPublished(db: Db, orgId: string): Promise<PublishedSkillDetail[]> {
  const [org] = await db.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, orgId));
  if (!org) return [];
  const skills = await db.select().from(publishedSkills).where(eq(publishedSkills.orgId, orgId)).orderBy(asc(publishedSkills.name));
  if (skills.length === 0) return [];
  const versions = await db
    .select({ v: publishedVersions, by: { id: users.id, name: users.name } })
    .from(publishedVersions)
    .innerJoin(publishedSkills, eq(publishedSkills.id, publishedVersions.skillId))
    .leftJoin(users, eq(users.id, publishedVersions.publishedBy))
    .where(eq(publishedSkills.orgId, orgId))
    .orderBy(desc(publishedVersions.version));
  return skills.map((s) => ({
    ...toSkill(org.slug, s),
    versions: versions.filter((r) => r.v.skillId === s.id).map((r) => toVersion(org.slug, s.name, r.v, r.by)),
  }));
}
