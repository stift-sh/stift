import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { ApiError, Whoami } from "@stift/shared";
import type { AuthEnv } from "../auth/middleware.js";

export const unauthorized = {
  401: { description: "missing or invalid bearer token", content: { "application/json": { schema: ApiError } } },
} as const;

export function whoami() {
  const r = new OpenAPIHono<AuthEnv>();
  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/whoami",
      tags: ["auth"],
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "the caller", content: { "application/json": { schema: Whoami } } },
        ...unauthorized,
      },
    }),
    (c) => c.json({ name: c.var.identity.name, admin: c.var.identity.admin }, 200),
  );
  return r;
}
