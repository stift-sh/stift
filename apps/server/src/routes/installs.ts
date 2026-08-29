import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq } from "drizzle-orm";
import { Install, InstallReport } from "@stift/shared";
import type { AuthEnv } from "../auth/middleware.js";
import type { Db } from "../db/client.js";
import { installs, users } from "../db/schema.js";
import { err, errors } from "./_errors.js";

const security = [{ bearerAuth: [] }];
const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});

/** Where org skills are on members' machines. The CLI reports on
 *  `stift skills install` and on org-scope pulls; the web reads it for the
 *  "Pulls" row on a skill. Reporting only: a missing row means "unknown",
 *  never "denied". Any member may report and read. Mount behind `bearer`. */
export function installsRoutes(db: Db) {
  const r = new OpenAPIHono<AuthEnv>();

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/installs",
      tags: ["installs"],
      security,
      request: { query: z.object({ agent: z.string().optional(), name: z.string().optional() }) },
      responses: { 200: json("reported installs in the caller's org, oldest first", z.array(Install)), 401: errors[401] },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const where = [eq(installs.orgId, c.var.identity.orgId)];
      if (q.agent) where.push(eq(installs.agent, q.agent));
      if (q.name) where.push(eq(installs.name, q.name));
      const rows = await db
        .select({ i: installs, user: { id: users.id, name: users.name } })
        .from(installs)
        .innerJoin(users, eq(users.id, installs.userId))
        .where(and(...where))
        .orderBy(asc(installs.updatedAt), asc(users.name));
      return c.json(
        rows.map(({ i, user }) => ({
          agent: i.agent,
          name: i.name,
          version: i.version,
          host: i.host,
          from: i.from,
          user,
          updated_at: i.updatedAt.toISOString(),
        })),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/v1/installs",
      tags: ["installs"],
      security,
      request: { body: { content: { "application/json": { schema: InstallReport } }, required: true } },
      responses: { 204: { description: "recorded (one row per user, agent, unit and host)" }, 400: errors[400], 401: errors[401] },
    }),
    async (c) => {
      const id = c.var.identity;
      const b = c.req.valid("json");
      if (!b.agent.trim() || !b.name.trim() || !b.host.trim()) return err(c, 400, "agent, name and host are required");
      const row = { orgId: id.orgId, userId: id.userId, agent: b.agent, name: b.name, host: b.host, version: b.version, from: b.from, updatedAt: new Date() };
      await db
        .insert(installs)
        .values(row)
        .onConflictDoUpdate({ target: [installs.orgId, installs.userId, installs.agent, installs.name, installs.host], set: { version: row.version, from: row.from, updatedAt: row.updatedAt } });
      return c.body(null, 204);
    },
    (result, c) => {
      if (!result.success) return err(c, 400, `bad request body: ${result.error.issues[0]?.message ?? "invalid"}`);
    },
  );

  return r;
}
