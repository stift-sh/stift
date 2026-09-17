import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Org, OrgUpdateRequest } from "@stift/shared";
import type { AuthEnv } from "../auth/middleware.js";
import { SlugError, SlugLockedError, SlugTakenError, updateOrg } from "../auth/orgs.js";
import { can } from "../auth/permissions.js";
import type { Db } from "../db/client.js";
import { orgOverview } from "../limits.js";
import { err, errors } from "./_errors.js";

/** Postgres unique_violation, bare or wrapped by drizzle. */
const isUniqueViolation = (e: unknown) =>
  [e, (e as { cause?: unknown } | null)?.cause].some((x) => (x as { code?: string } | null | undefined)?.code === "23505");

/** The caller's org with limits and usage, open to every member (the web's
 *  org card; the cloud billing screen later); admins rename it and set the
 *  slug skills are published under. Mount behind `bearer`. */
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
  r.openapi(
    createRoute({
      method: "patch",
      path: "/v1/org",
      tags: ["org"],
      security: [{ bearerAuth: [] }],
      request: { body: { content: { "application/json": { schema: OrgUpdateRequest } }, required: true } },
      responses: {
        200: { description: "the updated org", content: { "application/json": { schema: Org } } },
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const id = c.var.identity;
      if (!can(id, { action: "org.manage" })) return err(c, 403, "admin role required");
      const patch = c.req.valid("json");
      try {
        if (!(await updateOrg(db, id.orgId, patch))) return err(c, 404, "no such org");
      } catch (e) {
        if (e instanceof SlugError) return err(c, 400, e.message);
        if (e instanceof SlugLockedError || e instanceof SlugTakenError) return err(c, 409, e.message);
        if (isUniqueViolation(e)) return err(c, 409, `slug "${patch.slug}" is taken`);
        throw e;
      }
      const o = await orgOverview(db, id.orgId);
      if (!o) return err(c, 404, "no such org");
      return c.json(o, 200);
    },
    (result, c) => {
      if (!result.success) return err(c, 400, `bad request body: ${result.error.issues[0]?.message ?? "invalid"}`);
    },
  );
  return r;
}
