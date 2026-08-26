import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

/** Default location of the built web bundle, relative to this package
 *  (apps/web/dist in the monorepo, /app/web in the container via STIFT_WEB_DIR). */
export const DEFAULT_WEB_DIR = resolve(fileURLToPath(import.meta.url), "../../../../web/dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Resolves which directory to serve, or null when no bundle exists. */
export async function findWebDir(dir = process.env.STIFT_WEB_DIR ?? DEFAULT_WEB_DIR): Promise<string | null> {
  try {
    await stat(join(dir, "index.html"));
    return dir;
  } catch {
    return null;
  }
}

/** Serves the SPA: static files by exact path, index.html for anything else.
 *  Mounted last, so /v1, /api and /healthz are already handled. */
export function web(dir: string) {
  const r = new Hono();
  const root = resolve(dir);
  const index = () => readFile(join(root, "index.html"));

  r.get("/*", async (c) => {
    const path = normalize(decodeURIComponent(new URL(c.req.url).pathname));
    const file = resolve(root, "." + path);
    if (file !== root && file.startsWith(root + "/")) {
      try {
        const s = await stat(file);
        if (s.isFile()) {
          const immutable = path.startsWith("/assets/");
          return c.body(await readFile(file), 200, {
            "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
            "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
          });
        }
      } catch {
        // fall through to the SPA shell
      }
    }
    return c.body(await index(), 200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" });
  });
  return r;
}
