import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Org } from "@stift/shared";
import type { AuthEnv } from "../auth/middleware.js";
import type { Db } from "../db/client.js";
import { orgOverview } from "../limits.js";
import { err, errors } from "./_errors.js";

/** The caller's org with limits and usage, open to every member (the web's
 *  org card; the cloud billing screen later). Mount behind `bearer`. */
export function org(db: Db) {
  const r = new OpenAPIHono<AuthEnv>();
  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/org",
      tags: ["org"],
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "the caller's org", content: { "application/json": { schema: Org } } },
        401: errors[401],
        404: errors[404],
      },
    }),
    async (c) => {
      const o = await orgOverview(db, c.var.identity.orgId);
      if (!o) return err(c, 404, "no such org");
      return c.json(o, 200);
    },
  );
  return r;
}
