import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { TokenCreateRequest, TokenCreated, TokenInfo } from "@stift/shared";
import type { AuthEnv } from "../auth/middleware.js";
import { can } from "../auth/permissions.js";
import { createToken, listTokens, revokeToken } from "../auth/tokens.js";
import type { Db } from "../db/client.js";
import { err, errors } from "./_errors.js";

const MAX_BODY = 1 << 20;
const security = [{ bearerAuth: [] }];
const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});

/** Token management. Mount behind `bearer`. Admins see and revoke every
 *  token in the org; members only their own (`token.manage` vs `token.own`).
 *  Tokens belong to the caller; creating one for another user is the
 *  members API (skills-registry-3 item 3). */
export function tokens(db: Db) {
  const r = new OpenAPIHono<AuthEnv>();

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/tokens",
      tags: ["tokens"],
      security,
      responses: { 200: json("the org's tokens for admins, the caller's own for members", z.array(TokenInfo)), 401: errors[401] },
    }),
    async (c) => {
      const id = c.var.identity;
      const all = can(id, { action: "token.manage" });
      return c.json(await listTokens(db, id.orgId, all ? undefined : id.userId), 200);
    },
  );

  // Go decodes with encoding/json: malformed bodies get our wording, not the
  // validator's. Reading the text here caches the body for the validator.
  r.use("/v1/tokens", async (c, next) => {
    if (c.req.method !== "POST") return next();
    try {
      JSON.parse((await c.req.text()).slice(0, MAX_BODY));
    } catch (e) {
      return err(c, 400, `bad request body: ${(e as Error).message}`);
    }
    await next();
  });

  r.openapi(
    createRoute({
      method: "post",
      path: "/v1/tokens",
      tags: ["tokens"],
      security,
      request: { body: { content: { "application/json": { schema: TokenCreateRequest } }, required: true } },
      responses: { 201: json("the new token; `token` is shown once", TokenCreated), 400: errors[400], 401: errors[401], 403: errors[403] },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const id = c.var.identity;
      if (!body.name) return err(c, 400, "name is required");
      // `admin` is a property of the caller's role now, not of the token.
      if (body.admin && !can(id, { action: "token.manage" })) return err(c, 403, "admin token required");
      const { raw, info } = await createToken(db, id.orgId, body.name, { userId: id.userId });
      return c.json({ ...info, token: raw }, 201);
    },
    (result, c) => {
      if (!result.success) return err(c, 400, `bad request body: ${result.error.issues[0]?.message ?? "invalid"}`);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/v1/tokens/{id}",
      tags: ["tokens"],
      security,
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "revoked" }, 400: errors[400], 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const caller = c.var.identity;
      if (id === caller.id) return err(c, 400, "refusing to revoke the token used for this request");
      // Members get 404 rather than 403 on foreign ids so they cannot enumerate them.
      const all = can(caller, { action: "token.manage" });
      if (!(await revokeToken(db, caller.orgId, id, all ? undefined : caller.userId))) return err(c, 404, "no such token");
      return c.body(null, 204);
    },
  );

  return r;
}
