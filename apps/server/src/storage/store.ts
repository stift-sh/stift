import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import type { Bundle, BundleFile, Session, SkillMeta } from "@stift/shared";
import type { Db } from "../db/client.js";
import { blobs, bundleVersions, bundles, sessions, users } from "../db/schema.js";
import { BlobStore } from "./blobs.js";
import { MissingBlobError, NotFoundError, StaleError } from "./errors.js";
import { parseFrontmatter } from "./frontmatter.js";
import { type BundleKey, validateKey, validBundlePath, validSha, validOrgId } from "./validate.js";

export type { BundleKey };

/** Narrows list results; every field optional. */
export type ListFilter = { agent?: string; project?: string; host?: string; query?: string };
export type BundleFilter = { scope?: string; agent?: string; project?: string; name?: string };

/** What the client sends on push: everything the server does not compute. */
export type SessionInput = Omit<Session, "id" | "sha256" | "size" | "created_at" | "updated_at"> & {
  /** The pushing user; recorded on the row, never returned to clients. */
  userId?: string;
};
export type PutStatus = "created" | "updated" | "unchanged";

/** Input manifest for putBundle; key fields, version and created are set by the store. */
export type BundleInput = Partial<Pick<Bundle, "parent" | "host" | "author" | "files">> & {
  /** The writing user; recorded as the unit's owner when the unit is created. */
  userId?: string;
};

/**
 * Storage abstraction the HTTP layer depends on. Every method is scoped to a
 * org ("" = default). Port of `Backend` in the former Go server (git history before 2026-08-27) engine/server/store.go:
 * session metadata, blob index and bundle manifests live in Postgres, session
 * archives and blob contents in an S3-compatible bucket.
 */
export interface Store {
  put(orgId: string, meta: SessionInput, archive: Readable): Promise<{ session: Session; status: PutStatus }>;
  get(orgId: string, id: string): Promise<Session | undefined>;
  /** `range` is an HTTP Range header value forwarded to the object store. */
  openArchive(orgId: string, id: string, range?: string): Promise<{ body: Readable; session: Session }>;
  delete(orgId: string, id: string): Promise<void>;
  list(orgId: string, f?: ListFilter): Promise<Session[]>;
  /** Accepts a full or unambiguous-prefix session id. */
  resolveId(orgId: string, prefix: string): Promise<string>;

  /** Reports which of the given sha256 digests are not stored. */
  hasBlobs(orgId: string, shas: string[]): Promise<string[]>;
  /** Stores content under its sha256; hash and size are verified. Re-putting is a no-op. */
  putBlob(orgId: string, sha: string, body: Readable, size: number): Promise<void>;
  openBlob(orgId: string, sha: string): Promise<Readable>;

  /** Writes version HEAD+1 atomically; StaleError / MissingBlobError on conflict. */
  putBundle(orgId: string, k: BundleKey, b: BundleInput, force?: boolean): Promise<Bundle>;
  /** Version 0 means HEAD. */
  getBundle(orgId: string, k: BundleKey, version?: number): Promise<Bundle | undefined>;
  /** HEAD manifest of every bundle matching f, sorted by scope, agent, project, name. */
  listBundles(orgId: string, f?: BundleFilter): Promise<Bundle[]>;
  /** Every version, newest first. */
  bundleHistory(orgId: string, k: BundleKey): Promise<Bundle[]>;
  deleteBundle(orgId: string, k: BundleKey): Promise<void>;
  /** `user_id` of the bundle row; null when unowned, undefined when there is no row. */
  bundleOwner(orgId: string, k: BundleKey): Promise<string | null | undefined>;
}

const FRONTMATTER_LIMIT = 64 << 10;

function newId(): string {
  return randomBytes(8).toString("hex");
}

function assertOrgId(orgId: string) {
  if (!validOrgId(orgId)) throw new Error(`invalid orgId "${orgId}"`);
}

function assertSha(sha: string) {
  if (!validSha(sha)) throw new Error(`invalid sha256 "${sha}"`);
}

function assertKey(k: BundleKey) {
  const err = validateKey(k);
  if (err) throw new Error(err);
}

type SessionRow = typeof sessions.$inferSelect;
type SessionUser = { id: string; name: string } | null;

function toSession(r: SessionRow, user: SessionUser = null): Session {
  return {
    ...(user ? { user } : {}),
    id: r.id,
    key: r.key,
    agent: r.agent,
    session_id: r.sessionId,
    project: r.project ?? undefined,
    project_id: r.projectId ?? undefined,
    repo: r.repo ?? undefined,
    host: r.host,
    title: r.title ?? undefined,
    base: r.base as Session["base"],
    files: r.files,
    size: r.size,
    sha256: r.sha256,
    mod_time: r.modTime.toISOString(),
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

async function readAll(r: Readable, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of r) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    chunks.push(buf);
    n += buf.length;
    if (n >= limit) {
      r.destroy();
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}

export class PgStore implements Store {
  constructor(
    private readonly db: Db,
    private readonly blobStore: BlobStore,
  ) {}

  // ---- sessions ----

  async put(orgId: string, meta: SessionInput, archive: Readable) {
    assertOrgId(orgId);
    const staged = await this.blobStore.stage(archive);
    let promoted = false;
    try {
      const result = await this.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(sessions)
          .where(and(eq(sessions.orgId, orgId), eq(sessions.key, meta.key)))
          .for("update");
        const now = new Date();
        if (existing && existing.sha256 === staged.sha256) {
          return { session: await this.withUser(tx, existing), status: "unchanged" as const };
        }
        const id = existing?.id ?? newId();
        const row: typeof sessions.$inferInsert = {
          orgId,
          id,
          userId: meta.userId ?? existing?.userId ?? null,
          key: meta.key,
          agent: meta.agent,
          sessionId: meta.session_id,
          project: meta.project ?? null,
          projectId: meta.project_id ?? null,
          repo: meta.repo ?? null,
          host: meta.host,
          title: meta.title ?? null,
          base: meta.base,
          files: meta.files,
          size: staged.size,
          sha256: staged.sha256,
          modTime: new Date(meta.mod_time),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        // The archive is written before the row so a reader never sees
        // metadata pointing at a missing object.
        await this.blobStore.promote(staged, this.blobStore.sessionKey(orgId, id));
        promoted = true;
        const [saved] = existing
          ? await tx
              .update(sessions)
              .set(row)
              .where(and(eq(sessions.orgId, orgId), eq(sessions.id, id)))
              .returning()
          : await tx.insert(sessions).values(row).returning();
        return { session: await this.withUser(tx, saved!), status: existing ? ("updated" as const) : ("created" as const) };
      });
      return result;
    } finally {
      if (!promoted) await this.blobStore.discard(staged);
    }
  }

  /** Joins the pushing user's name onto a row. */
  private async withUser(db: Pick<Db, "select">, r: SessionRow): Promise<Session> {
    if (!r.userId) return toSession(r);
    const [u] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, r.userId));
    return toSession(r, u ?? null);
  }

  private sessionSelect() {
    return this.db
      .select({ session: sessions, user: { id: users.id, name: users.name } })
      .from(sessions)
      .leftJoin(users, eq(users.id, sessions.userId));
  }

  async get(orgId: string, id: string) {
    const [row] = await this.sessionSelect().where(and(eq(sessions.orgId, orgId), eq(sessions.id, id)));
    return row ? toSession(row.session, row.user) : undefined;
  }

  async openArchive(orgId: string, id: string, range?: string) {
    const session = await this.get(orgId, id);
    if (!session) throw new NotFoundError(`session ${id} not found`);
    const obj = await this.blobStore.get(this.blobStore.sessionKey(orgId, id), { range });
    if (!obj) throw new NotFoundError(`archive for session ${id} not found`);
    return { body: obj.body, session };
  }

  async delete(orgId: string, id: string) {
    const deleted = await this.db
      .delete(sessions)
      .where(and(eq(sessions.orgId, orgId), eq(sessions.id, id)))
      .returning({ id: sessions.id });
    if (deleted.length === 0) throw new NotFoundError(`session ${id} not found`);
    await this.blobStore.delete(this.blobStore.sessionKey(orgId, id)).catch(() => {});
  }

  async list(orgId: string, f: ListFilter = {}) {
    const conds = [eq(sessions.orgId, orgId)];
    if (f.agent) conds.push(eq(sessions.agent, f.agent));
    if (f.project) conds.push(eq(sessions.project, f.project));
    if (f.host) conds.push(eq(sessions.host, f.host));
    if (f.query) {
      const q = `%${f.query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
      conds.push(
        like(
          sql`lower(concat_ws(' ', ${sessions.title}, ${sessions.project}, ${sessions.sessionId}))`,
          q,
        ),
      );
    }
    const rows = await this.sessionSelect()
      .where(and(...conds))
      .orderBy(desc(sessions.updatedAt), asc(sessions.id));
    return rows.map((r) => toSession(r.session, r.user));
  }

  async resolveId(orgId: string, prefix: string) {
    if (prefix === "") throw new NotFoundError("session not found");
    const rows = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.orgId, orgId), like(sessions.id, `${prefix.replace(/[\\%_]/g, "\\$&")}%`)))
      .limit(2);
    if (rows.some((r) => r.id === prefix)) return prefix;
    if (rows.length === 0) throw new NotFoundError("session not found");
    if (rows.length > 1) throw new Error(`ambiguous id prefix "${prefix}"`);
    return rows[0]!.id;
  }

  // ---- blobs ----

  async hasBlobs(orgId: string, shas: string[]) {
    assertOrgId(orgId);
    for (const s of shas) assertSha(s);
    if (shas.length === 0) return [];
    const rows = await this.db
      .select({ sha256: blobs.sha256 })
      .from(blobs)
      .where(and(eq(blobs.orgId, orgId), inArray(blobs.sha256, shas)));
    const have = new Set(rows.map((r) => r.sha256));
    return shas.filter((s) => !have.has(s));
  }

  async putBlob(orgId: string, sha: string, body: Readable, size: number) {
    assertOrgId(orgId);
    assertSha(sha);
    if ((await this.hasBlobs(orgId, [sha])).length === 0) {
      body.resume(); // already stored; drain and ignore
      return;
    }
    const stored = await this.blobStore.putVerified(this.blobStore.blobKey(orgId, sha), body, { sha256: sha, size });
    await this.db.insert(blobs).values({ orgId, sha256: sha, size: stored.size }).onConflictDoNothing();
  }

  async openBlob(orgId: string, sha: string) {
    if (!validOrgId(orgId) || !validSha(sha)) throw new NotFoundError("blob not found");
    if ((await this.hasBlobs(orgId, [sha])).length > 0) throw new NotFoundError("blob not found");
    const obj = await this.blobStore.get(this.blobStore.blobKey(orgId, sha));
    if (!obj) throw new NotFoundError("blob not found");
    return obj.body;
  }

  // ---- bundles ----

  private bundleWhere(orgId: string, k: BundleKey) {
    return and(
      eq(bundles.orgId, orgId),
      eq(bundles.scope, k.scope),
      eq(bundles.agent, k.agent),
      eq(bundles.project, k.project ?? ""),
      eq(bundles.name, k.name),
    );
  }

  async putBundle(orgId: string, k: BundleKey, b: BundleInput, force = false) {
    assertOrgId(orgId);
    assertKey(k);
    const files = [...(b.files ?? [])];
    const seen = new Set<string>();
    for (const f of files) {
      if (!validBundlePath(f.path)) throw new Error(`invalid file path "${f.path}"`);
      if (seen.has(f.path)) throw new Error(`duplicate file path "${f.path}"`);
      seen.add(f.path);
      if (!validSha(f.sha256)) throw new Error(`invalid sha256 "${f.sha256}" for ${f.path}`);
    }
    files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

    const missing = await this.hasBlobs(orgId, files.map((f) => f.sha256));
    if (missing.length > 0) throw new MissingBlobError(missing);
    const skills = await this.parseSkills(orgId, files);
    const parent = b.parent ?? 0;

    return this.db.transaction(async (tx) => {
      // Upsert the bundle row and lock it so concurrent writers serialize.
      await tx
        .insert(bundles)
        .values({ orgId, scope: k.scope, agent: k.agent, project: k.project ?? "", name: k.name, userId: b.userId ?? null })
        .onConflictDoNothing();
      const [row] = await tx.select().from(bundles).where(this.bundleWhere(orgId, k)).for("update");
      if (!row) throw new Error("bundle row vanished");

      // Re-check blob presence under the lock: the manifest must never
      // reference a blob that is not in the index.
      const stillMissing = await this.hasBlobs(orgId, files.map((f) => f.sha256));
      if (stillMissing.length > 0) throw new MissingBlobError(stillMissing);

      if (!force && parent !== row.head) throw new StaleError(row.head, parent);
      // The first write claims an unowned (legacy) row.
      if (row.userId === null && b.userId) await tx.update(bundles).set({ userId: b.userId }).where(eq(bundles.id, row.id));
      const created = new Date();
      const manifest: Bundle = {
        scope: k.scope as Bundle["scope"],
        agent: k.agent,
        project: k.project || undefined,
        name: k.name,
        version: row.head + 1,
        parent,
        host: b.host ?? "",
        author: b.author ?? "",
        created: created.toISOString(),
        files,
        skills,
      };
      await tx.insert(bundleVersions).values({ bundleId: row.id, version: manifest.version, manifest, createdAt: created });
      await tx.update(bundles).set({ head: manifest.version }).where(eq(bundles.id, row.id));
      return manifest;
    });
  }

  async getBundle(orgId: string, k: BundleKey, version = 0) {
    if (!validOrgId(orgId) || validateKey(k)) return undefined;
    const [row] = await this.db.select().from(bundles).where(this.bundleWhere(orgId, k));
    if (!row || row.head === 0) return undefined;
    const v = version === 0 ? row.head : version;
    if (v < 0 || v > row.head) return undefined;
    const [ver] = await this.db
      .select({ manifest: bundleVersions.manifest })
      .from(bundleVersions)
      .where(and(eq(bundleVersions.bundleId, row.id), eq(bundleVersions.version, v)));
    return ver?.manifest;
  }

  async listBundles(orgId: string, f: BundleFilter = {}) {
    if (!validOrgId(orgId)) return [];
    const conds = [eq(bundles.orgId, orgId), sql`${bundles.head} > 0`];
    if (f.scope) conds.push(eq(bundles.scope, f.scope));
    if (f.agent) conds.push(eq(bundles.agent, f.agent));
    if (f.project) conds.push(eq(bundles.project, f.project));
    if (f.name) conds.push(eq(bundles.name, f.name));
    const rows = await this.db
      .select({ manifest: bundleVersions.manifest })
      .from(bundles)
      .innerJoin(
        bundleVersions,
        and(eq(bundleVersions.bundleId, bundles.id), eq(bundleVersions.version, bundles.head)),
      )
      .where(and(...conds))
      .orderBy(asc(bundles.scope), asc(bundles.agent), asc(bundles.project), asc(bundles.name));
    return rows.map((r) => r.manifest);
  }

  async bundleHistory(orgId: string, k: BundleKey) {
    if (!validOrgId(orgId) || validateKey(k)) return [];
    const [row] = await this.db.select().from(bundles).where(this.bundleWhere(orgId, k));
    if (!row) return [];
    const rows = await this.db
      .select({ manifest: bundleVersions.manifest })
      .from(bundleVersions)
      .where(eq(bundleVersions.bundleId, row.id))
      .orderBy(desc(bundleVersions.version));
    return rows.map((r) => r.manifest);
  }

  async bundleOwner(orgId: string, k: BundleKey) {
    if (!validOrgId(orgId) || validateKey(k)) return undefined;
    const [row] = await this.db.select({ userId: bundles.userId }).from(bundles).where(this.bundleWhere(orgId, k));
    return row?.userId;
  }

  async deleteBundle(orgId: string, k: BundleKey) {
    assertOrgId(orgId);
    assertKey(k);
    // Versions cascade; the row itself goes so numbering restarts from 1.
    const deleted = await this.db
      .delete(bundles)
      .where(and(this.bundleWhere(orgId, k), sql`${bundles.head} > 0`))
      .returning({ id: bundles.id });
    if (deleted.length === 0) throw new NotFoundError("bundle not found");
  }

  /** Extracts name/description from every SKILL.md in files, sorted by path. */
  private async parseSkills(orgId: string, files: BundleFile[]): Promise<SkillMeta[]> {
    const skills: SkillMeta[] = [];
    for (const f of files) {
      if (f.path.split("/").pop() !== "SKILL.md") continue;
      const obj = await this.blobStore.get(this.blobStore.blobKey(orgId, f.sha256), {
        range: `bytes=0-${FRONTMATTER_LIMIT - 1}`,
      });
      if (!obj) throw new MissingBlobError([f.sha256]);
      const text = await readAll(obj.body, FRONTMATTER_LIMIT);
      const { name, description } = parseFrontmatter(text);
      skills.push({ path: f.path, name, description });
    }
    skills.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    return skills;
  }
}

export { BlobStore, MissingBlobError, NotFoundError, StaleError };
