import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PublishRequest, PublishedSkillDetail, PublishedVersion } from "@stift/shared";
import type { AuthEnv } from "../auth/middleware.js";
import { can } from "../auth/permissions.js";
import type { Store } from "../storage/store.js";
import { NotFoundError, PublishConflictError, PublishError } from "../storage/errors.js";
import { err, errors } from "./_errors.js";

const security = [{ bearerAuth: [] }];
const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});
const name = z.object({ name: z.string().describe("public name, the `<name>` of `@<org>/<name>`") });
const version = z.object({ version: z.coerce.number().int().min(1).optional().describe("one version; absent = the whole skill") });
/** The store errors these routes can raise; anything else is a 500. */
function publishError(c: Parameters<typeof err>[0], e: unknown) {
  if (e instanceof NotFoundError) return err(c, 404, e.message);
  if (e instanceof PublishError) return err(c, 400, e.message);
  if (e instanceof PublishConflictError) return err(c, 409, e.message);
  throw e;
}
const badBody = (result: { success: boolean; error?: z.ZodError }, c: Parameters<typeof err>[0]) => {
  if (!result.success) return err(c, 400, `bad request: ${result.error?.issues[0]?.message ?? "invalid"}`);
};

/** The org's side of public sharing: what it publishes under
 *  `@<slug>/<name>`. Reading is open to every member; publishing, hiding
 *  and restoring need `skill.publish` (admins). The public, unauthenticated
 *  registry that serves what is published here is item 3. Mount behind
 *  `bearer`. */
export function published(store: Store) {
  const r = new OpenAPIHono<AuthEnv>();

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/published",
      tags: ["published"],
      security,
      responses: { 200: json("the org's published skills with every version, hidden ones included", z.array(PublishedSkillDetail)), 401: errors[401] },
    }),
    async (c) => c.json(await store.listPublished(c.var.identity.orgId), 200),
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/v1/published",
      tags: ["published"],
      security,
      request: { body: { content: { "application/json": { schema: PublishRequest } }, required: true } },
      responses: {
        201: json("the new version", PublishedVersion),
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const id = c.var.identity;
      if (!can(id, { action: "skill.publish" })) return err(c, 403, "admin role required");
      const b = c.req.valid("json");
      try {
        return c.json(await store.publish(id.orgId, { ...b, userId: id.userId }), 201);
      } catch (e) {
        return publishError(c, e);
      }
    },
    badBody,
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/v1/published/{name}",
      tags: ["published"],
      security,
      request: { params: name, query: version },
      responses: {
        204: { description: "hidden from search and `latest`; versions still resolve by number" },
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errors[404],
      },
    }),
    async (c) => {
      const id = c.var.identity;
      if (!can(id, { action: "skill.publish" })) return err(c, 403, "admin role required");
      try {
        await store.unpublish(id.orgId, c.req.valid("param").name, c.req.valid("query").version);
      } catch (e) {
        return publishError(c, e);
      }
      return c.body(null, 204);
    },
    badBody,
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/v1/published/{name}/restore",
      tags: ["published"],
      security,
      request: { params: name, query: version },
      responses: {
        204: { description: "visible again" },
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errors[404],
      },
    }),
    async (c) => {
      const id = c.var.identity;
      if (!can(id, { action: "skill.publish" })) return err(c, 403, "admin role required");
      try {
        await store.restore(id.orgId, c.req.valid("param").name, c.req.valid("query").version);
      } catch (e) {
        return publishError(c, e);
      }
      return c.body(null, 204);
    },
    badBody,
  );

  return r;
}
