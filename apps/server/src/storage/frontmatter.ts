/**
 * Reads a leading "---" YAML-ish block and returns the top-level name and
 * description scalars. Simple "key: value" lines and ">" / "|" block scalars
 * (folded to one line) are understood; quotes around the value are stripped.
 * Port of ParseFrontmatter in cli/engine/server/bundles.go.
 */
export function parseFrontmatter(text: string): { name: string; description: string } {
  const out = { name: "", description: "" };
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || (lines[0] ?? "").replace(/^\ufeff/, "").trim() !== "---") return out;

  let block: "name" | "description" | null = null;
  let blockLines: string[] = [];
  const flush = () => {
    if (block) out[block] = blockLines.join(" ").trim();
    block = null;
    blockLines = [];
  };

  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    if (line === "" || line[0] === " " || line[0] === "\t") {
      if (block && line.trim() !== "") blockLines.push(line.trim());
      continue;
    }
    flush();
    if (line[0] === "#") continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (key !== "name" && key !== "description") continue;
    if (val === ">" || val === "|" || val === ">-" || val === "|-") {
      block = key;
      continue;
    }
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  flush();
  return out;
}
