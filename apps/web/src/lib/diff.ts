// Minimal line diff (LCS) and manifest diff; no dependency.
import type { Bundle, BundleFile } from "@stift/shared";

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  // lcs[i][j] = LCS length of x[i..] and y[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ kind: "same", text: x[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: x[i++] });
    } else {
      out.push({ kind: "add", text: y[j++] });
    }
  }
  while (i < n) out.push({ kind: "del", text: x[i++] });
  while (j < m) out.push({ kind: "add", text: y[j++] });
  return out;
}

export type FileChange = { path: string; kind: "added" | "removed" | "modified" | "mode"; before?: BundleFile; after?: BundleFile };

/** Which files changed between two manifests, by sha and mode. */
export function diffManifests(before: Bundle, after: Bundle): FileChange[] {
  const a = new Map(before.files.map((f) => [f.path, f]));
  const b = new Map(after.files.map((f) => [f.path, f]));
  const out: FileChange[] = [];
  for (const [p, f] of a) {
    const g = b.get(p);
    if (!g) out.push({ path: p, kind: "removed", before: f });
    else if (f.sha256 !== g.sha256) out.push({ path: p, kind: "modified", before: f, after: g });
    else if (f.mode !== g.mode) out.push({ path: p, kind: "mode", before: f, after: g });
  }
  for (const [p, g] of b) if (!a.has(p)) out.push({ path: p, kind: "added", after: g });
  return out.sort((l, r) => l.path.localeCompare(r.path));
}

export const MAX_TEXT_DIFF = 256 * 1024;
export const isBinary = (s: string) => s.includes("\0");
