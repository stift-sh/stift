import path from "node:path/posix";

/** Bounds how deep a unit name may nest. */
export const MAX_NAME_SEGMENTS = 3;

/** Tenant names are used as storage prefixes; guard against traversal. */
export function validTenant(tenant: string): boolean {
  return tenant === "" || /^[A-Za-z0-9_-]+$/.test(tenant);
}

/** Lowercase hex SHA-256 digest. */
export function validSha(sha: string): boolean {
  return /^[0-9a-f]{64}$/.test(sha);
}

/** Scope/agent names. */
export function validSegment(seg: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(seg) && seg !== "." && seg !== "..";
}

/** Clean, relative, forward-slash paths only. */
export function validBundlePath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("\\") || /[\0\n\r\t]/.test(p)) return false;
  if (path.normalize(p) !== p) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  // Windows drive-letter absolutes like "C:/x".
  if (p.length >= 2 && p[1] === ":") return false;
  return true;
}

/** 1..MAX_NAME_SEGMENTS clean segments, no control characters. */
export function validUnitName(name: string): boolean {
  if (!validBundlePath(name)) return false;
  if (name.split("/").length > MAX_NAME_SEGMENTS) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f\x7f]/.test(name);
}

export type BundleKey = { scope: string; agent: string; project?: string; name: string };

/** Returns an error message, or null when the key names a storable bundle. */
export function validateKey(k: BundleKey): string | null {
  if (!["user", "project", "org"].includes(k.scope)) return `invalid scope "${k.scope}"`;
  if (!validSegment(k.agent)) return `invalid agent "${k.agent}"`;
  if ((k.scope === "project") !== Boolean(k.project)) return "project must be set exactly when scope=project";
  if (!validUnitName(k.name)) return `invalid bundle name "${k.name}" (want 1-${MAX_NAME_SEGMENTS} clean path segments)`;
  return null;
}
