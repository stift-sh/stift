import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Org, OrgLimitsRequest } from "@stift/shared";
import { removeMember } from "../auth/members.js";
import type { Db } from "../db/client.js";
import { orgOverview, setOrgLimits, type OrgLimits } from "../limits.js";
import { err, errors } from "./_errors.js";

const security = [{ serviceToken: [] }];
const orgParam = z.object({ id: z.string().openapi({ description: "org id" }) });

const digest = (s: string) => createHash("sha256").update(s).digest();

/** `Authorization: Bearer <STIFT_SERVICE_TOKEN>`. Digests are compared so
 *  neither content nor length of the secret shows in the timing. */
function serviceAuth(token: string): MiddlewareHandler {
  const want = digest(token);
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const raw = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!raw) return err(c, 401, "missing bearer token");
    if (!timingSafeEqual(digest(raw), want)) return err(c, 401, "invalid token");
    await next();
  };
}

/** The operator's API (STIFT_SERVICE_TOKEN): a billing service writes an
 *  org's limits from entitlements, removes members the identity provider
 *  dropped, and reads usage. Any org, by id: mount it ahead of `bearer`, so
 *  no user identity reaches it and it needs none. */
export function service(db: Db, token: string) {
  const r = new OpenAPIHono();
  r.use("/v1/service/*", serviceAuth(token));

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/service/orgs/{id}",
      tags: ["service"],
      security,
      request: { params: orgParam },
      responses: {
        200: { description: "the org with limits and usage", content: { "application/json": { schema: Org } } },
        401: errors[401],
        404: errors[404],
      },
    }),
    async (c) => {
      const o = await orgOverview(db, c.req.valid("param").id);
      if (!o) return err(c, 404, "no such org");
      return c.json(o, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "put",
      path: "/v1/service/orgs/{id}/limits",
      tags: ["service"],
      security,
      request: { params: orgParam, body: { content: { "application/json": { schema: OrgLimitsRequest } }, required: true } },
      responses: {
        200: { description: "the org with its new limits", content: { "application/json": { schema: Org } } },
        400: errors[400],
        401: errors[401],
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const limits: Partial<OrgLimits> = {};
      if (body.max_skills !== undefined) limits.maxSkills = body.max_skills;
      if (body.max_storage_bytes !== undefined) limits.maxStorageBytes = body.max_storage_bytes;
      if (body.max_seats !== undefined) limits.maxSeats = body.max_seats;
      if (body.max_sessions !== undefined) limits.maxSessions = body.max_sessions;
      await setOrgLimits(db, id, limits);
      const o = await orgOverview(db, id);
      if (!o) return err(c, 404, "no such org");
      return c.json(o, 200);
    },
    (result, c) => {
      if (!result.success) return err(c, 400, `bad request body: ${result.error.issues[0]?.message ?? "invalid"}`);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/v1/service/orgs/{id}/members/{userId}",
      tags: ["service"],
      security,
      request: { params: orgParam.extend({ userId: z.string().openapi({ description: "user id" }) }) },
      responses: { 204: { description: "removed, with the member's tokens" }, 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      const { id, userId } = c.req.valid("param");
      if (!(await removeMember(db, id, userId))) return err(c, 404, "no such member");
      return c.body(null, 204);
    },
  );

  return r;
}
