// Audit timeline: per version, who published from where and how many files
// were added, changed or removed relative to the previous version. Derived
// from manifests alone, so it needs no extra storage.
import type { Bundle } from "@stift/shared";
import { diffManifests } from "./diff";

export type AuditEntry = { version: Bundle; added: number; changed: number; removed: number; paths: string[] };

/** `history` in any order; returns newest first. */
export function auditTimeline(history: Bundle[]): AuditEntry[] {
  const sorted = [...history].sort((a, b) => a.version - b.version);
  return sorted
    .map((v, i) => {
      const prev = sorted[i - 1];
      const changes = prev ? diffManifests(prev, v) : v.files.map((f) => ({ path: f.path, kind: "added" as const }));
      return {
        version: v,
        added: changes.filter((c) => c.kind === "added").length,
        changed: changes.filter((c) => c.kind === "modified" || c.kind === "mode").length,
        removed: changes.filter((c) => c.kind === "removed").length,
        paths: changes.map((c) => c.path),
      };
    })
    .reverse();
}
