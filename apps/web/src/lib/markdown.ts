// Tiny markdown renderer for SKILL.md: headings, paragraphs, lists, code
// blocks, blockquotes, inline code/emphasis/links. Raw HTML is never passed
// through (it is shown as text) and only http(s)/mailto/relative links are
// linked. YAML front matter is split off for the caller to show separately.
import { createElement as h, Fragment, type ReactNode } from "react";

export type Parsed = { frontMatter: string | null; body: string };

export function splitFrontMatter(src: string): Parsed {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  return m ? { frontMatter: m[1], body: src.slice(m[0].length) } : { frontMatter: null, body: src };
}

const SAFE_HREF = /^(https?:\/\/|mailto:|\.{0,2}\/|#)/i;
const safeHref = (href: string) => (SAFE_HREF.test(href.trim()) ? href.trim() : null);

/** Inline: code, links, bold, italic. Everything else is plain text. */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]]+)\]\(([^)\s]+)\)|(\*\*|__)(?=\S)([\s\S]*?\S)\5|(\*|_)(?=\S)([^*_]*?\S)\7/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) out.push(h("code", { key: k++ }, m[2].trim()));
    else if (m[3] !== undefined) {
      const href = safeHref(m[4]);
      out.push(href ? h("a", { key: k++, href, rel: "noopener noreferrer", target: "_blank" }, ...renderInline(m[3])) : m[0]);
    } else if (m[6] !== undefined) out.push(h("strong", { key: k++ }, ...renderInline(m[6])));
    else if (m[8] !== undefined) out.push(h("em", { key: k++ }, ...renderInline(m[8])));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; lines: string[] }
  | { t: "code"; lang: string; lines: string[] }
  | { t: "quote"; lines: string[] }
  | { t: "list"; ordered: boolean; items: string[][] }
  | { t: "hr" };

export function parseBlocks(body: string): Block[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(`{3,}|~{3,})\s*(\S*)/.exec(line))) {
      const fence = m[1][0];
      const code: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^${fence}{3,}\\s*$`).test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push({ t: "code", lang: m[2], lines: code });
      continue;
    }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      blocks.push({ t: "h", level: m[1].length, text: m[2] });
      i++;
      continue;
    }
    if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ t: "quote", lines: q });
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if ((m = li.exec(line))) {
      const ordered = /\d/.test(m[2]);
      const items: string[][] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const im = li.exec(cur);
        if (im && /\d/.test(im[2]) === ordered) {
          items.push([im[3]]);
          i++;
        } else if (cur.trim() && /^\s+/.test(cur) && items.length) {
          items[items.length - 1].push(cur.trim());
          i++;
        } else break;
      }
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    const p: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|`{3}|~{3})/.test(lines[i]) && !li.test(lines[i])) p.push(lines[i++].trim());
    blocks.push({ t: "p", lines: p });
  }
  return blocks;
}

export function renderMarkdown(body: string): ReactNode {
  return h(
    Fragment,
    null,
    ...parseBlocks(body).map((b, k): ReactNode => {
      switch (b.t) {
        case "h":
          return h(`h${b.level}`, { key: k }, ...renderInline(b.text));
        case "p":
          return h("p", { key: k }, ...renderInline(b.lines.join(" ")));
        case "code":
          return h("pre", { key: k, "data-lang": b.lang || undefined }, h("code", null, b.lines.join("\n")));
        case "quote":
          return h("blockquote", { key: k }, renderMarkdown(b.lines.join("\n")));
        case "list":
          return h(b.ordered ? "ol" : "ul", { key: k }, ...b.items.map((it, j) => h("li", { key: j }, ...renderInline(it.join(" ")))));
        case "hr":
          return h("hr", { key: k });
      }
    }),
  );
}
