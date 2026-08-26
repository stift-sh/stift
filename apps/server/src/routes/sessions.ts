import { Readable } from "node:stream";
import { Busboy, type BusboyFileStream, type BusboyInstance } from "@fastify/busboy";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { stream } from "hono/streaming";
import { PushMeta, PushResult, Session, SessionFilter } from "@stift/shared";
import type { AuthEnv } from "../auth/middleware.js";
import type { Limits } from "../limits.js";
import { NotFoundError } from "../storage/errors.js";
import type { Store } from "../storage/store.js";
import { TooLargeError, limited } from "./_body.js";
import { err, errors } from "./_errors.js";

const MAX_META = 1 << 20;
const security = [{ bearerAuth: [] }];
const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});
const idParam = z.object({ id: z.string().openapi({ description: "session id or unambiguous prefix" }) });

type Outcome = { status: 200 | 201 | 400 | 413 | 500; body: unknown };

/**
 * Streams a multipart push: the `meta` JSON field must precede the `archive`
 * file, which is handed to the store as it arrives. Port of handlePush.
 */
function readPush(
  body: Readable,
  contentType: string,
  put: (meta: PushMeta, archive: Readable) => Promise<Outcome>,
): Promise<Outcome> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (o: Outcome) => {
      if (done) return;
      done = true;
      resolve(o);
    };
    let bb: BusboyInstance;
    try {
      bb = new Busboy({ headers: { "content-type": contentType }, limits: { fieldSize: MAX_META } });
    } catch (e) {
      return finish({ status: 400, body: { error: `expected multipart/form-data: ${(e as Error).message}` } });
    }
    let meta: PushMeta | undefined;
    let claimed = false; // an archive part reached the store; its promise settles the outcome
    bb.on("field", (name: string, value: string) => {
      if (name !== "meta") return;
      try {
        meta = JSON.parse(value) as PushMeta;
      } catch (e) {
        finish({ status: 400, body: { error: `bad meta: ${(e as Error).message}` } });
        body.destroy();
      }
    });
    bb.on("file", (name: string, file: BusboyFileStream) => {
      if (name !== "archive" || done) return file.resume();
      if (!meta) {
        file.resume();
        return finish({ status: 400, body: { error: "meta field must precede archive field" } });
      }
      const m = meta;
      if (!m.key || !m.agent || !m.session_id) {
        file.resume();
        return finish({ status: 400, body: { error: "meta requires key, agent and session_id" } });
      }
      if (m.base !== "home" && m.base !== "project") {
        file.resume();
        return finish({ status: 400, body: { error: 'meta.base must be "home" or "project"' } });
      }
      // Errors on the request body (over limit, aborted) must reach the
      // consumer of the file stream, which busboy does not forward itself.
      claimed = true;
      body.once("error", (e) => file.destroy(e));
      put(m, file).then(finish, (e) => finish(errorOutcome(e)));
    });
    bb.on("finish", () => {
      if (!claimed) finish({ status: 400, body: { error: "missing archive field" } });
    });
    bb.on("error", (e: Error) => finish(errorOutcome(e)));
    body.on("error", (e) => finish(errorOutcome(e)));
    body.pipe(bb);
  });
}

function errorOutcome(e: unknown): Outcome {
  if (e instanceof TooLargeError) return { status: 413, body: { error: `archive exceeds limit of ${e.limit} bytes` } };
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && e.name === "TooLargeError") return { status: 413, body: { error: msg } };
  return { status: 500, body: { error: msg } };
}

/** Session sync: push, list, get, archive download, delete. Mount behind `bearer`. */
export function sessions(store: Store, limits: Limits) {
  const r = new OpenAPIHono<AuthEnv>();

  // Registered by hand: r.openapi() would buffer and validate the multipart
  // body, and the archive must stream to the store instead.
  r.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      path: "/v1/sessions",
      tags: ["sessions"],
      security,
      request: {
        body: {
          content: {
            "multipart/form-data": {
              schema: z.object({
                meta: PushMeta.openapi({ description: "JSON; must precede archive" }),
                archive: z.string().openapi({ format: "binary", description: "tar.gz of the session files" }),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: json("updated or unchanged", PushResult),
        201: json("created", PushResult),
        400: errors[400],
        401: errors[401],
        413: errors[413],
        500: errors[500],
      },
    }),
  );
  r.post("/v1/sessions", async (c) => {
    const tenant = c.var.identity.tenant;
    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("multipart/form-data")) {
      return err(c, 400, "expected multipart/form-data: request Content-Type isn't multipart/form-data");
    }
    const body = limited(c.req.raw.body, limits.maxUploadBytes);
    const out = await readPush(body, ct, async (meta, archive) => {
      // Go zero values for the optional fields.
      const input = { ...meta, files: meta.files ?? 0, mod_time: meta.mod_time ?? new Date(0).toISOString() };
      const { session, status } = await store.put(tenant, input, archive);
      return { status: status === "created" ? 201 : 200, body: { session, status } };
    });
    if (out.status === 201) return c.json(out.body as PushResult, 201);
    if (out.status === 200) return c.json(out.body as PushResult, 200);
    return err(c, out.status, (out.body as { error: string }).error);
  });

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/sessions",
      tags: ["sessions"],
      security,
      request: { query: SessionFilter },
      responses: { 200: json("sessions, most recently updated first", z.array(Session)), 401: errors[401] },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const list = await store.list(c.var.identity.tenant, { agent: q.agent, project: q.project, host: q.host, query: q.q });
      return c.json(list, 200);
    },
  );

  /** Resolves an id or prefix; returns a response on failure. */
  const resolve = async (c: { var: AuthEnv["Variables"] }, prefix: string): Promise<{ id: string } | { error: 404 | 400; msg: string }> => {
    try {
      return { id: await store.resolveId(c.var.identity.tenant, prefix) };
    } catch (e) {
      if (e instanceof NotFoundError) return { error: 404, msg: "no such session" };
      return { error: 400, msg: (e as Error).message };
    }
  };

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/sessions/{id}",
      tags: ["sessions"],
      security,
      request: { params: idParam },
      responses: { 200: json("the session", Session), 400: errors[400], 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      const res = await resolve(c, c.req.valid("param").id);
      if ("error" in res) return err(c, res.error, res.msg);
      const s = await store.get(c.var.identity.tenant, res.id);
      if (!s) return err(c, 404, "no such session");
      return c.json(s, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/sessions/{id}/archive",
      tags: ["sessions"],
      security,
      request: { params: idParam, headers: z.object({ range: z.string().optional() }) },
      responses: {
        200: { description: "the tar.gz archive", content: { "application/gzip": { schema: z.string().openapi({ format: "binary" }) } } },
        206: { description: "partial content", content: { "application/gzip": { schema: z.string().openapi({ format: "binary" }) } } },
        400: errors[400],
        401: errors[401],
        404: errors[404],
        416: { description: "range not satisfiable" },
      },
    }),
    async (c) => {
      const res = await resolve(c, c.req.valid("param").id);
      if ("error" in res) return err(c, res.error, res.msg);
      const tenant = c.var.identity.tenant;
      const session = await store.get(tenant, res.id);
      if (!session) return err(c, 404, "no such session");

      // Single-range subset of http.ServeContent: bytes=a-b, bytes=a-, bytes=-n.
      const lastModified = new Date(session.updated_at).toUTCString();
      const range = parseRange(c.req.header("range"), session.size);
      if (range === "unsatisfiable") {
        c.header("Content-Range", `bytes */${session.size}`);
        return c.body(null, 416);
      }
      const ims = c.req.header("if-modified-since");
      if (ims && !range && Math.floor(new Date(session.updated_at).getTime() / 1000) <= Math.floor(new Date(ims).getTime() / 1000)) {
        c.header("Last-Modified", lastModified);
        return c.body(null, 304);
      }

      let archive: { body: Readable };
      try {
        archive = await store.openArchive(tenant, res.id, range ? `bytes=${range.start}-${range.end}` : undefined);
      } catch (e) {
        if (e instanceof NotFoundError) return err(c, 404, "no such session");
        throw e;
      }
      c.header("Content-Type", "application/gzip");
      c.header("Content-Disposition", `attachment; filename="${session.agent}-${session.id}.tar.gz"`);
      c.header("Last-Modified", lastModified);
      c.header("Accept-Ranges", "bytes");
      if (range) {
        c.header("Content-Range", `bytes ${range.start}-${range.end}/${session.size}`);
        c.header("Content-Length", String(range.end - range.start + 1));
        c.status(206);
      } else {
        c.header("Content-Length", String(session.size));
        c.status(200);
      }
      return stream(c, async (s) => {
        for await (const chunk of archive.body) await s.write(chunk as Uint8Array);
      });
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/v1/sessions/{id}",
      tags: ["sessions"],
      security,
      request: { params: idParam },
      responses: { 204: { description: "deleted" }, 400: errors[400], 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      const res = await resolve(c, c.req.valid("param").id);
      if ("error" in res) return err(c, res.error, res.msg);
      try {
        await store.delete(c.var.identity.tenant, res.id);
      } catch (e) {
        if (e instanceof NotFoundError) return err(c, 404, "no such session");
        throw e;
      }
      return c.body(null, 204);
    },
  );

  return r;
}

type ByteRange = { start: number; end: number };

/** Parses a single-range `Range` header against a known size. Invalid or
 *  multi-range headers are ignored (full body), as in net/http. */
export function parseRange(header: string | undefined, size: number): ByteRange | undefined | "unsatisfiable" {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, a, b] = m;
  if (a === "" && b === "") return undefined;
  let start: number, end: number;
  if (a === "") {
    const n = Number(b);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}
