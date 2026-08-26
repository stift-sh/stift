// Skills: bundle list (server-side scope/agent filters), one version,
// history, blob text, rollback (a PUT of an old version's files, like the
// CLI) and delete. Failures become ApiError so a 401 still signs out.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteV1BundlesByScopeByAgentByName,
  getV1BlobsBySha,
  getV1Bundles,
  getV1BundlesByScopeByAgentByName,
  putV1BlobsBySha,
  putV1BundlesByScopeByAgentByName,
} from "@stift/api-client";
import type { Bundle, BundleFile } from "@stift/shared";
import { ApiError } from "./auth";
import { unwrap } from "./unwrap";
import "./client";

export type SkillKey = { scope: string; agent: string; name: string; project?: string };
export type SkillFilter = { scope?: string; agent?: string; q?: string };

type Result<T> = { data?: T; error?: unknown; response: Response };


export function cleanFilter(f: SkillFilter): SkillFilter {
  const out: SkillFilter = {};
  for (const k of ["scope", "agent", "q"] as const) {
    const v = f[k]?.trim();
    if (v) out[k] = v;
  }
  return out;
}

/** Route for a bundle: /skills/:scope/:agent/*name?project=&v=&diff=&edit=&add= */
export function keyHref(key: SkillKey, extra: { v?: number; diff?: number; edit?: string; add?: boolean } = {}): string {
  const name = key.name.split("/").map(encodeURIComponent).join("/");
  const q = new URLSearchParams();
  if (key.project) q.set("project", key.project);
  if (extra.v) q.set("v", String(extra.v));
  if (extra.diff) q.set("diff", String(extra.diff));
  if (extra.edit) q.set("edit", extra.edit);
  if (extra.add) q.set("add", "1");
  const qs = q.toString();
  return `/skills/${encodeURIComponent(key.scope)}/${encodeURIComponent(key.agent)}/${name}${qs ? `?${qs}` : ""}`;
}

export function keyOf(b: Bundle): SkillKey {
  return { scope: b.scope, agent: b.agent, name: b.name, project: b.project || undefined };
}

/** "skills/hello" -> "hello"; "CLAUDE.md" -> "CLAUDE.md". */
export function unitLabel(name: string): string {
  const parts = name.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

const path = (k: SkillKey) => ({ scope: k.scope, agent: k.agent, name: k.name });
const projectQuery = (k: SkillKey) => (k.project ? { project: k.project } : {});
const keyId = (k: SkillKey) => [k.scope, k.agent, k.project ?? "", k.name];

export function useBundles(filter: SkillFilter) {
  const { scope, agent } = cleanFilter(filter);
  const query = { ...(scope ? { scope } : {}), ...(agent ? { agent } : {}) };
  return useQuery({
    queryKey: ["bundles", query],
    queryFn: () => unwrap<Bundle[]>(getV1Bundles({ query }), "could not list skills"),
  });
}

/** One manifest; version 0 is HEAD. */
export function useBundle(key: SkillKey, version = 0) {
  return useQuery({
    queryKey: ["bundles", "detail", ...keyId(key), version],
    queryFn: () =>
      unwrap<Bundle>(
        getV1BundlesByScopeByAgentByName({ path: path(key), query: { ...projectQuery(key), ...(version ? { version: String(version) } : {}) } }) as Promise<Result<Bundle>>,
        "skill not found",
      ),
    retry: false,
    enabled: !!key.name,
  });
}

export function useBundleHistory(key: SkillKey) {
  return useQuery({
    queryKey: ["bundles", "history", ...keyId(key)],
    queryFn: () =>
      unwrap<Bundle[]>(
        getV1BundlesByScopeByAgentByName({ path: path(key), query: { ...projectQuery(key), history: "1" } }) as Promise<Result<Bundle[]>>,
        "skill not found",
      ),
    retry: false,
    enabled: !!key.name,
  });
}

export async function fetchBlobText(sha: string): Promise<string> {
  return unwrap<string>(getV1BlobsBySha({ path: { sha }, parseAs: "text" }) as Promise<Result<string>>, "could not read file");
}

export function useBlobText(sha: string | undefined) {
  return useQuery({
    queryKey: ["blobs", sha],
    queryFn: () => fetchBlobText(sha!),
    enabled: !!sha,
    staleTime: Infinity, // content-addressed: never changes
  });
}

/** Republishes `old.files` as a new HEAD, exactly like `stift skills rollback`. */
export function useRollback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, old, head }: { key: SkillKey; old: Bundle; head: Bundle }) =>
      unwrap<Bundle>(
        putV1BundlesByScopeByAgentByName({
          path: path(key),
          query: projectQuery(key),
          body: { parent: head.version, host: "web", files: old.files },
        }),
        "could not roll back",
      ),
    onSuccess: (_, { key }) => {
      void qc.invalidateQueries({ queryKey: ["bundles"] });
      void qc.invalidateQueries({ queryKey: ["bundles", "history", ...keyId(key)] });
    },
  });
}

export function useDeleteBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: SkillKey) =>
      unwrap<void>(deleteV1BundlesByScopeByAgentByName({ path: path(key), query: projectQuery(key) }), "could not delete skill"),
    onSuccess: (_, key) => {
      qc.removeQueries({ queryKey: ["bundles", "detail", ...keyId(key)] });
      qc.removeQueries({ queryKey: ["bundles", "history", ...keyId(key)] });
      void qc.invalidateQueries({ queryKey: ["bundles"] });
    },
  });
}

const enc = new TextEncoder();
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A file whose content is new: hashed and uploaded before the manifest is written. */
export type NewFile = { path: string; text: string; mode?: number };

export type Publish = {
  key: SkillKey;
  /** Version this edit was based on; 0 for a brand new unit. */
  parent: number;
  /** Files kept as-is from an existing version. */
  keep: BundleFile[];
  /** Files with new content. */
  write: NewFile[];
  /** Overwrite a stale parent (after a 409). */
  force?: boolean;
};

export const isEditable = (path: string) => /\.md$/i.test(path);

/** Hash + upload the changed blobs, then PUT the manifest; exactly what
 *  `stift push --skills` does. A stale parent surfaces as ApiError(409). */
export async function publish(p: Publish): Promise<Bundle> {
  const written: BundleFile[] = await Promise.all(
    p.write.map(async (f) => {
      const bytes = enc.encode(f.text);
      const sha = await sha256Hex(f.text);
      // Raw bytes rather than a Blob: fetch sets Content-Length either way, and jsdom stringifies foreign Blobs.
      await unwrap(putV1BlobsBySha({ path: { sha }, headers: { "content-type": "application/octet-stream" }, body: bytes.buffer as unknown as Blob }) as Promise<Result<unknown>>, "could not upload file");
      return { path: f.path, sha256: sha, size: bytes.byteLength, mode: f.mode ?? 0o644 };
    }),
  );
  const files = [...p.keep.filter((k) => !p.write.some((w) => w.path === k.path)), ...written].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return unwrap<Bundle>(
    putV1BundlesByScopeByAgentByName({
      path: path(p.key),
      query: { ...projectQuery(p.key), ...(p.force ? { force: "1" } : {}) },
      body: { parent: p.parent, host: "web", files },
    }),
    "could not save",
  );
}

export function usePublish() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: publish,
    onSuccess: (_, { key }) => {
      void qc.invalidateQueries({ queryKey: ["bundles"] });
      void qc.invalidateQueries({ queryKey: ["bundles", "history", ...keyId(key)] });
    },
  });
}
