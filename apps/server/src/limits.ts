import { and, count, eq, gt, sum } from "drizzle-orm";
import type { Org } from "@stift/shared";
import type { Db } from "./db/client.js";
import { blobs, bundles, memberships, orgs } from "./db/schema.js";

/** Upload size limits; defaults match the Go server. A request-size guard,
 *  global to the server; the per-org quota is `OrgLimits` below. */
export type Limits = {
  /** per-session archive size limit */
  maxUploadBytes: number;
  /** per-blob (bundle file) size limit */
  maxBlobBytes: number;
};

export const DEFAULT_LIMITS: Limits = { maxUploadBytes: 200 << 20, maxBlobBytes: 5 << 20 };

function intEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name}: expected a positive integer, got "${v}"`);
  return n;
}

export function limitsFromEnv(): Limits {
  return {
    maxUploadBytes: intEnv("STIFT_MAX_UPLOAD_BYTES", DEFAULT_LIMITS.maxUploadBytes),
    maxBlobBytes: intEnv("STIFT_MAX_BLOB_BYTES", DEFAULT_LIMITS.maxBlobBytes),
  };
}

// ---- org quota ----

/** Per-org quota, the `orgs.max_*` columns; null = unlimited (the self-host
 *  default). Enforced in the store and on membership insert with LimitError;
 *  the cloud writes the columns from entitlements. */
export type OrgLimits = { maxSkills: number | null; maxStorageBytes: number | null; maxSeats: number | null };

const ORG_LIMIT_ENV = {
  maxSkills: "STIFT_MAX_SKILLS",
  maxStorageBytes: "STIFT_MAX_STORAGE_BYTES",
  maxSeats: "STIFT_MAX_SEATS",
} as const satisfies Record<keyof OrgLimits, string>;

/** Limits named in the environment: a positive integer, or `unlimited` to
 *  clear one. Unset variables are absent from the result, so a limit edited
 *  in the row survives a restart. */
export function orgLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<OrgLimits> {
  const out: Partial<OrgLimits> = {};
  for (const [key, name] of Object.entries(ORG_LIMIT_ENV) as [keyof OrgLimits, string][]) {
    const v = env[name];
    if (v === undefined || v === "") continue;
    out[key] = v === "unlimited" ? null : intEnv(name, 0, env);
  }
  return out;
}

export async function setOrgLimits(db: Db, orgId: string, limits: Partial<OrgLimits>) {
  if (Object.keys(limits).length === 0) return;
  await db.update(orgs).set(limits).where(eq(orgs.id, orgId));
}

/** The org's limits; `lock` takes the row FOR UPDATE so check-then-insert
 *  serializes within a transaction. An org without a row has no limits. */
export async function orgLimits(db: Pick<Db, "select">, orgId: string, lock = false): Promise<OrgLimits> {
  const q = db
    .select({ maxSkills: orgs.maxSkills, maxStorageBytes: orgs.maxStorageBytes, maxSeats: orgs.maxSeats })
    .from(orgs)
    .where(eq(orgs.id, orgId));
  const [row] = lock ? await q.for("update") : await q;
  return row ?? { maxSkills: null, maxStorageBytes: null, maxSeats: null };
}

/** Units with at least one version, in every scope. */
export async function countSkills(db: Pick<Db, "select">, orgId: string) {
  const [r] = await db.select({ n: count() }).from(bundles).where(and(eq(bundles.orgId, orgId), gt(bundles.head, 0)));
  return r?.n ?? 0;
}

/** Bytes of bundle file content (the blob index); session archives are not counted. */
export async function storageBytes(db: Pick<Db, "select">, orgId: string) {
  const [r] = await db.select({ n: sum(blobs.size) }).from(blobs).where(eq(blobs.orgId, orgId));
  return Number(r?.n ?? 0);
}

export async function countSeats(db: Pick<Db, "select">, orgId: string) {
  const [r] = await db.select({ n: count() }).from(memberships).where(eq(memberships.orgId, orgId));
  return r?.n ?? 0;
}

/** The org with its limits and current usage (GET /v1/org). */
export async function orgOverview(db: Db, orgId: string): Promise<Org | undefined> {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return undefined;
  const [skills, storage_bytes, seats] = await Promise.all([countSkills(db, orgId), storageBytes(db, orgId), countSeats(db, orgId)]);
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    limits: { skills: org.maxSkills, storage_bytes: org.maxStorageBytes, seats: org.maxSeats },
    usage: { skills, storage_bytes, seats },
  };
}
