import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Bundle, BundleFilter, BundleInput } from "@stift/shared";
import type { AuthEnv } from "../auth/middleware.js";
import { MissingBlobError, NotFoundError, StaleError } from "../storage/errors.js";
import type { Store } from "../storage/store.js";
import { validUnitName, type BundleKey } from "../storage/validate.js";
import { err, errors } from "./_errors.js";

/** Go: maxBundleManifest. */
const MAX_MANIFEST = 2 << 20;
const security = [{ bearerAuth: [] }];
const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});

// `{name}{.+}` lets the unit name span path segments (skills/hello); the
// OpenAPI path is rewritten to `{name}` in emit-openapi.
const keyPath = "/v1/bundles/{scope}/{agent}/{name}{.+}";
const keyParams = z.object({
  scope: z.string().openapi({ description: "user | project | org" }),
  agent: z.string(),
  name: z.string().openapi({ description: "unit name, 1-3 path segments" }),
});
const projectQuery = z.object({ project: z.string().optional().openapi({ description: "abs path, required when scope=project" }) });

/** Versioned skill bundles. Mount behind `bearer`. */
export function bundles(store: Store) {
  const r = new OpenAPIHono<AuthEnv>();

  const keyFrom = (params: z.infer<typeof keyParams>, project: string | undefined): BundleKey => ({
    scope: params.scope,
    agent: params.agent,
    project: project || undefined,
    name: params.name,
  });

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/bundles",
      tags: ["bundles"],
      security,
      request: { query: BundleFilter },
      responses: { 200: json("HEAD manifest of every matching bundle", z.array(Bundle)), 401: errors[401] },
    }),
    async (c) => c.json(await store.listBundles(c.var.identity.tenant, c.req.valid("query")), 200),
  );

  r.use(keyPath.replace("{scope}", ":scope").replace("{agent}", ":agent").replace("{name}{.+}", "*"), async (c, next) => {
    // Org scope writes need an admin token (requireScopeWrite).
    if ((c.req.method === "PUT" || c.req.method === "DELETE") && c.req.path.startsWith("/v1/bundles/org/") && !c.var.identity.admin) {
      return err(c, 403, "org scope requires an admin token");
    }
    if (c.req.method === "PUT") {
      try {
        JSON.parse((await c.req.text()).slice(0, MAX_MANIFEST));
      } catch (e) {
        return err(c, 400, `bad bundle: ${(e as Error).message}`);
      }
    }
    await next();
  });

  r.openapi(
    createRoute({
      method: "put",
      path: keyPath,
      tags: ["bundles"],
      security,
      request: {
        params: keyParams,
        query: projectQuery.extend({ force: z.string().optional().openapi({ description: "1 to overwrite a stale parent" }) }),
        body: { content: { "application/json": { schema: BundleInput } }, required: true },
      },
      responses: {
        201: json("the stored version", Bundle),
        400: errors[400],
        401: errors[401],
        403: errors[403],
        409: errors[409],
        412: errors[412],
      },
    }),
    async (c) => {
      const id = c.var.identity;
      const q = c.req.valid("query");
      const k = keyFrom(c.req.valid("param"), q.project);
      const body = c.req.valid("json");
      const input = { ...body, author: body.author || id.name };
      try {
        return c.json(await store.putBundle(id.tenant, k, input, q.force === "1"), 201);
      } catch (e) {
        if (e instanceof StaleError) {
          const head = await store.getBundle(id.tenant, k, 0);
          const msg = head ? `stale: current head is version ${head.version}, bundle parent is ${body.parent ?? 0}` : e.message;
          return err(c, 409, msg);
        }
        if (e instanceof MissingBlobError) return err(c, 412, e.message);
        if (e instanceof Error && !(e instanceof NotFoundError)) return err(c, 400, e.message);
        throw e;
      }
    },
    (result, c) => {
      if (!result.success) return err(c, 400, `bad bundle: ${result.error.issues[0]?.message ?? "invalid"}`);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: keyPath,
      tags: ["bundles"],
      security,
      request: {
        params: keyParams,
        query: projectQuery.extend({
          version: z.string().optional().openapi({ description: "0 or absent for HEAD" }),
          history: z.string().optional().openapi({ description: "1 for every version, newest first" }),
        }),
      },
      responses: {
        200: json("one manifest, or `Bundle[]` with ?history=1", Bundle.or(z.array(Bundle))),
        400: errors[400],
        401: errors[401],
        404: errors[404],
      },
    }),
    async (c) => {
      const tenant = c.var.identity.tenant;
      const q = c.req.valid("query");
      const k = keyFrom(c.req.valid("param"), q.project);
      if (!validUnitName(k.name)) return err(c, 400, "invalid bundle name");
      if (q.history === "1") {
        if (!(await store.getBundle(tenant, k, 0))) return err(c, 404, "no such bundle");
        return c.json(await store.bundleHistory(tenant, k), 200);
      }
      let version = 0;
      if (q.version !== undefined && q.version !== "") {
        if (!/^\d+$/.test(q.version)) return err(c, 400, "version must be a non-negative integer");
        version = Number(q.version);
      }
      const b = await store.getBundle(tenant, k, version);
      if (!b) return err(c, 404, "no such bundle");
      return c.json(b, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: keyPath,
      tags: ["bundles"],
      security,
      request: { params: keyParams, query: projectQuery },
      responses: { 204: { description: "deleted" }, 400: errors[400], 401: errors[401], 403: errors[403], 404: errors[404] },
    }),
    async (c) => {
      const k = keyFrom(c.req.valid("param"), c.req.valid("query").project);
      try {
        await store.deleteBundle(c.var.identity.tenant, k);
      } catch (e) {
        if (e instanceof NotFoundError) return err(c, 404, "no such bundle");
        if (e instanceof Error) return err(c, 400, e.message);
        throw e;
      }
      return c.body(null, 204);
    },
  );

  return r;
}
