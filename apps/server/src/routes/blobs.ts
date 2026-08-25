import { Readable } from "node:stream";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { stream } from "hono/streaming";
import { BlobPutResponse, BlobsCheckRequest, BlobsCheckResponse } from "@stift/shared";
import type { AuthEnv } from "../auth/middleware.js";
import type { Limits } from "../limits.js";
import type { Store } from "../storage/store.js";
import { validSha } from "../storage/validate.js";
import { HashMismatchError } from "../storage/blobs.js";
import { err, errors } from "./_errors.js";

/** Go: maxBlobCheck / maxBundleManifest. */
const MAX_CHECK = 10000;
const MAX_MANIFEST = 2 << 20;

const security = [{ bearerAuth: [] }];
const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});
const shaParam = z.object({ sha: z.string().openapi({ description: "hex sha256 of the content" }) });

/** Thrown by the counting limiter when the body outgrows the limit. */
class TooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`blob exceeds limit of ${limit} bytes`);
  }
}

/** Port of http.MaxBytesReader: counts bytes and fails once `limit` is passed,
 *  so a lying Content-Length cannot smuggle a larger body through. */
function limited(body: ReadableStream<Uint8Array>, limit: number): Readable {
  let seen = 0;
  const reader = body.getReader();
  return new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) return this.push(null);
        seen += value.byteLength;
        if (seen > limit) {
          await reader.cancel().catch(() => {});
          return this.destroy(new TooLargeError(limit));
        }
        this.push(Buffer.from(value));
      } catch (e) {
        this.destroy(e as Error);
      }
    },
  });
}

/** Content-addressed bundle file storage. Mount behind `bearer`. */
export function blobs(store: Store, limits: Limits) {
  const r = new OpenAPIHono<AuthEnv>();

  r.use("/v1/blobs/check", async (c, next) => {
    if (c.req.method !== "POST") return next();
    try {
      JSON.parse((await c.req.text()).slice(0, MAX_MANIFEST));
    } catch (e) {
      return err(c, 400, `bad request body: ${(e as Error).message}`);
    }
    await next();
  });

  r.openapi(
    createRoute({
      method: "post",
      path: "/v1/blobs/check",
      tags: ["blobs"],
      security,
      request: { body: { content: { "application/json": { schema: BlobsCheckRequest } }, required: true } },
      responses: { 200: json("digests the server does not have", BlobsCheckResponse), 400: errors[400], 401: errors[401] },
    }),
    async (c) => {
      const { shas } = c.req.valid("json");
      if (shas.length > MAX_CHECK) return err(c, 400, `at most ${MAX_CHECK} shas per check`);
      for (const s of shas) if (!validSha(s)) return err(c, 400, `invalid sha256 "${s}"`);
      return c.json({ missing: await store.hasBlobs(c.var.identity.tenant, shas) }, 200);
    },
    (result, c) => {
      if (!result.success) return err(c, 400, `bad request body: ${result.error.issues[0]?.message ?? "invalid"}`);
    },
  );

  r.openapi(
    createRoute({
      method: "put",
      path: "/v1/blobs/{sha}",
      tags: ["blobs"],
      security,
      request: {
        params: shaParam,
        body: { content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } }, required: true },
      },
      responses: {
        200: json("stored (or already present)", BlobPutResponse),
        400: errors[400],
        401: errors[401],
        411: errors[411],
        413: errors[413],
      },
    }),
    async (c) => {
      const { sha } = c.req.valid("param");
      if (!validSha(sha)) return err(c, 400, "invalid sha256 in path");
      const lengthHeader = c.req.header("content-length");
      const length = lengthHeader === undefined ? -1 : Number(lengthHeader);
      if (!Number.isInteger(length) || length < 0) return err(c, 411, "Content-Length is required");
      if (length > limits.maxBlobBytes) return err(c, 413, `blob exceeds limit of ${limits.maxBlobBytes} bytes`);
      const body = limited(c.req.raw.body ?? new ReadableStream({ start: (ctl) => ctl.close() }), limits.maxBlobBytes);
      try {
        await store.putBlob(c.var.identity.tenant, sha, body, length);
      } catch (e) {
        if (e instanceof TooLargeError) return err(c, 413, e.message);
        if (e instanceof HashMismatchError) return err(c, 400, e.message);
        throw e;
      }
      return c.json({ sha }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/blobs/{sha}",
      tags: ["blobs"],
      security,
      request: { params: shaParam },
      responses: {
        200: { description: "blob content", content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } },
        400: errors[400],
        401: errors[401],
        404: errors[404],
      },
    }),
    async (c) => {
      const { sha } = c.req.valid("param");
      if (!validSha(sha)) return err(c, 400, "invalid sha256 in path");
      let body: Readable;
      try {
        body = await store.openBlob(c.var.identity.tenant, sha);
      } catch (e) {
        if (e instanceof Error && e.name === "NotFoundError") return err(c, 404, "no such blob");
        throw e;
      }
      c.header("Content-Type", "application/octet-stream");
      return stream(c, async (s) => {
        for await (const chunk of body) await s.write(chunk as Uint8Array);
      });
    },
  );

  return r;
}
