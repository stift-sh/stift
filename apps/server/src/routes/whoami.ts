import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { ApiError, Whoami } from "@stift/shared";
import { eq } from "drizzle-orm";
import type { AuthEnv } from "../auth/middleware.js";
import type { Db } from "../db/client.js";
import { orgs } from "../db/schema.js";

export const unauthorized = {
  401: { description: "missing or invalid bearer token", content: { "application/json": { schema: ApiError } } },
} as const;

/** `db` is optional so the app builds without one (OpenAPI emitter, tests);
 *  `org` is then omitted. */
export function whoami(db?: Db) {
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
    async (c) => {
      const id = c.var.identity;
      const org = db ? await db.query.orgs.findFirst({ where: eq(orgs.id, id.orgId) }) : undefined;
      return c.json(
        {
          name: id.name,
          admin: id.admin,
          role: id.role,
          user: { id: id.userId, name: id.userName },
          ...(org ? { org: { id: org.id, slug: org.slug, name: org.name } } : {}),
        },
        200,
      );
    },
  );
  return r;
}
