import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { TokenCreateRequest, TokenCreated, TokenInfo } from "@stift/shared";
import type { AuthEnv } from "../auth/middleware.js";
import { createToken, listTokens, revokeToken } from "../auth/tokens.js";
import type { Db } from "../db/client.js";
import { err, errors } from "./_errors.js";

const MAX_BODY = 1 << 20;
const security = [{ bearerAuth: [] }];
const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});

/** Admin-only token management. Mount behind `bearer` + `requireAdmin`. */
export function tokens(db: Db) {
  const r = new OpenAPIHono<AuthEnv>();

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/tokens",
      tags: ["tokens"],
      security,
      responses: { 200: json("all tokens", z.array(TokenInfo)), 401: errors[401], 403: errors[403] },
    }),
    async (c) => c.json(await listTokens(db, c.var.identity.tenant), 200),
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
      if (!body.name) return err(c, 400, "name is required");
      const { raw, info } = await createToken(db, c.var.identity.tenant, body.name, body.admin ?? false);
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
      responses: { 204: { description: "revoked" }, 400: errors[400], 401: errors[401], 403: errors[403], 404: errors[404] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const caller = c.var.identity;
      if (id === caller.id) return err(c, 400, "refusing to revoke the token used for this request");
      if (!(await revokeToken(db, caller.tenant, id))) return err(c, 404, "no such token");
      return c.body(null, 204);
    },
  );

  return r;
}
