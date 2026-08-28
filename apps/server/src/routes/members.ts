import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Member, MemberCreateRequest, MemberCreated, MemberUpdateRequest } from "@stift/shared";
import type { AuthEnv } from "../auth/middleware.js";
import { addMember, countAdmins, findMember, listMembers, MemberExistsError, removeMember, setRole } from "../auth/members.js";
import { can } from "../auth/permissions.js";
import { createToken } from "../auth/tokens.js";
import type { Db } from "../db/client.js";
import { err, errors } from "./_errors.js";

const security = [{ bearerAuth: [] }];
const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});
const param = z.object({ id: z.string().describe("user id or name") });

/** Members of the caller's org. Listing is open to every member (names show
 *  up on sessions and tokens anyway); adding, role changes and removal are
 *  `member.manage`, i.e. admins. Mount behind `bearer`. */
export function members(db: Db) {
  const r = new OpenAPIHono<AuthEnv>();

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/members",
      tags: ["members"],
      security,
      responses: { 200: json("members of the caller's org", z.array(Member)), 401: errors[401] },
    }),
    async (c) => c.json(await listMembers(db, c.var.identity.orgId), 200),
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/v1/members",
      tags: ["members"],
      security,
      request: { body: { content: { "application/json": { schema: MemberCreateRequest } }, required: true } },
      responses: {
        201: json("the new member; `token` (when requested) is shown once", MemberCreated),
        400: errors[400],
        401: errors[401],
        403: errors[403],
        409: errors[409],
      },
    }),
    async (c) => {
      const id = c.var.identity;
      if (!can(id, { action: "member.manage" })) return err(c, 403, "admin token required");
      const body = c.req.valid("json");
      const name = body.name.trim();
      if (!name) return err(c, 400, "name is required");
      let m: Member;
      try {
        m = await addMember(db, id.orgId, { name, email: body.email, role: body.role ?? "member" });
      } catch (e) {
        if (e instanceof MemberExistsError) return err(c, 409, e.message);
        throw e;
      }
      if (!body.token) return c.json(m, 201);
      const { raw } = await createToken(db, id.orgId, body.token, { userId: m.id });
      return c.json({ ...m, tokens: 1, token: raw }, 201);
    },
    (result, c) => {
      if (!result.success) return err(c, 400, `bad request body: ${result.error.issues[0]?.message ?? "invalid"}`);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/v1/members/{id}",
      tags: ["members"],
      security,
      request: { params: param, body: { content: { "application/json": { schema: MemberUpdateRequest } }, required: true } },
      responses: { 200: json("the updated member", Member), 400: errors[400], 401: errors[401], 403: errors[403], 404: errors[404] },
    }),
    async (c) => {
      const id = c.var.identity;
      if (!can(id, { action: "member.manage" })) return err(c, 403, "admin token required");
      const m = await findMember(db, id.orgId, c.req.valid("param").id);
      if (!m) return err(c, 404, "no such member");
      const { role } = c.req.valid("json");
      if (m.role === "admin" && role !== "admin" && (await countAdmins(db, id.orgId)) <= 1) {
        return err(c, 400, "refusing to demote the last admin");
      }
      await setRole(db, id.orgId, m.id, role);
      return c.json({ ...m, role }, 200);
    },
    (result, c) => {
      if (!result.success) return err(c, 400, `bad request body: ${result.error.issues[0]?.message ?? "invalid"}`);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/v1/members/{id}",
      tags: ["members"],
      security,
      request: { params: param },
      responses: { 204: { description: "removed, with the member's tokens" }, 400: errors[400], 401: errors[401], 403: errors[403], 404: errors[404] },
    }),
    async (c) => {
      const id = c.var.identity;
      if (!can(id, { action: "member.manage" })) return err(c, 403, "admin token required");
      const m = await findMember(db, id.orgId, c.req.valid("param").id);
      if (!m) return err(c, 404, "no such member");
      if (m.id === id.userId) return err(c, 400, "refusing to remove yourself");
      await removeMember(db, id.orgId, m.id);
      return c.body(null, 204);
    },
  );

  return r;
}
