// Skills: bundle list (server-side scope/agent filters), one version,
// history, blob text, rollback (a PUT of an old version's files, like the
// CLI) and delete. Failures become ApiError so a 401 still signs out.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteV1BundlesByScopeByAgentByName,
  getV1BlobsBySha,
  getV1Bundles,
  getV1BundlesByScopeByAgentByName,
  putV1BundlesByScopeByAgentByName,
} from "@stift/api-client";
import type { Bundle } from "@stift/shared";
import { ApiError } from "./auth";
import "./client";

export type SkillKey = { scope: string; agent: string; name: string; project?: string };
export type SkillFilter = { scope?: string; agent?: string; q?: string };

type Result<T> = { data?: T; error?: unknown; response: Response };

async function unwrap<T>(call: Promise<Result<T>>, fallback: string): Promise<T> {
  const res = await call.catch(() => undefined);
  if (!res) throw new ApiError(0, "could not reach the server");
  if (res.error !== undefined || (res.data === undefined && res.response.status !== 204)) {
    const err = res.error;
    const msg = err && typeof err === "object" && "error" in err && typeof err.error === "string" ? err.error : fallback;
    throw new ApiError(res.response.status, msg);
  }
  return res.data as T;
}

export function cleanFilter(f: SkillFilter): SkillFilter {
  const out: SkillFilter = {};
  for (const k of ["scope", "agent", "q"] as const) {
    const v = f[k]?.trim();
    if (v) out[k] = v;
  }
  return out;
}

/** Route for a bundle: /skills/:scope/:agent/*name?project=&v=&diff= */
export function keyHref(key: SkillKey, extra: { v?: number; diff?: number } = {}): string {
  const name = key.name.split("/").map(encodeURIComponent).join("/");
  const q = new URLSearchParams();
  if (key.project) q.set("project", key.project);
  if (extra.v) q.set("v", String(extra.v));
  if (extra.diff) q.set("diff", String(extra.diff));
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
