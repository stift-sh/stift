import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Version } from "@stift/shared";
import { API_VERSION } from "../app.js";

export function health(opts: { version: string; features?: string[] }) {
  const r = new OpenAPIHono();

  r.openapi(
    createRoute({
      method: "get",
      path: "/healthz",
      tags: ["meta"],
      responses: { 200: { description: "ok", content: { "text/plain": { schema: z.literal("ok") } } } },
    }),
    (c) => c.text("ok", 200),
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/api/version",
      tags: ["meta"],
      responses: { 200: { description: "server version", content: { "application/json": { schema: Version } } } },
    }),
    (c) => c.json({ version: opts.version, api: API_VERSION, features: opts.features ?? [] }, 200),
  );

  return r;
}
