import type { Readable } from "node:stream";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { stream } from "hono/streaming";
import { RegistrySearch, RegistrySkill } from "@stift/shared";
import type { Store } from "../storage/store.js";
import { NotFoundError } from "../storage/errors.js";
import { SEARCH_LIMIT } from "../storage/registry.js";
import { err, errors } from "./_errors.js";

const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: { "application/json": { schema } },
});

/** Versioned manifests and blobs never change; `latest` and search do. */
const IMMUTABLE = "public, max-age=31536000, immutable";
const SHORT = "public, max-age=60";

const ref = z.object({
  org: z.string().openapi({ description: "org slug, written `@<org>` in the path", example: "@acme" }),
  name: z.string().openapi({ example: "deploy" }),
});
const refVersion = ref.extend({ version: z.coerce.number().int().min(1) });

/** Strips the `@` the path carries; a ref without it is a 404, not a 400,
 *  so the public surface reveals nothing about the syntax it rejects. */
const orgOf = (s: string) => (s.startsWith("@") ? s.slice(1) : "");

/**
 * The public registry: how anyone, logged in or not, resolves
 * `@<org>/<name>[@<version>]` and fetches its files with checksums to
 * verify. Read-only. Mount **ahead of** `bearer`. The blob route serves a
 * digest only when it is in that version's manifest (skills-registry-4 D3):
 * an open `GET /blobs/<sha>` would be an existence and content oracle for
 * every private blob in the org. Rate limiting is the reverse proxy's job.
 */
export function registry(store: Store) {
  const r = new OpenAPIHono();
  const notFound = (c: Parameters<typeof err>[0], e: unknown) => {
    if (e instanceof NotFoundError) return err(c, 404, e.message);
    throw e;
  };

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/registry/skills",
      tags: ["registry"],
      request: {
        query: z.object({
          q: z.string().optional().describe("matches name, description or org slug, case-insensitively"),
          limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT).optional().describe(`page size, default 20, max ${SEARCH_LIMIT}`),
          cursor: z.string().optional().describe("`next` from the previous page"),
        }),
      },
      responses: { 200: json("visible published skills, newest first", RegistrySearch), 400: errors[400] },
    }),
    async (c) => {
      c.header("Cache-Control", SHORT);
      return c.json(await store.searchPublished(c.req.valid("query")), 200);
    },
    (result, c) => {
      if (!result.success) return err(c, 400, `bad request: ${result.error.issues[0]?.message ?? "invalid"}`);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/registry/skills/{org}/{name}",
      tags: ["registry"],
      request: { params: ref },
      responses: { 200: json("the skill at its latest visible version", RegistrySkill), 404: errors[404] },
    }),
    async (c) => {
      const p = c.req.valid("param");
      try {
        const out = await store.getPublished(orgOf(p.org), p.name);
        c.header("Cache-Control", SHORT);
        return c.json(out, 200);
      } catch (e) {
        return notFound(c, e);
      }
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/registry/skills/{org}/{name}/{version}",
      tags: ["registry"],
      request: { params: refVersion },
      responses: {
        200: json("the skill at that version; `unpublished_at` is set when it was hidden after publishing", RegistrySkill),
        404: errors[404],
      },
    }),
    async (c) => {
      const p = c.req.valid("param");
      try {
        const out = await store.getPublished(orgOf(p.org), p.name, p.version);
        c.header("Cache-Control", IMMUTABLE);
        return c.json(out, 200);
      } catch (e) {
        return notFound(c, e);
      }
    },
    (result, c) => {
      if (!result.success) return err(c, 404, "not found");
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/v1/registry/skills/{org}/{name}/{version}/blobs/{sha}",
      tags: ["registry"],
      request: { params: refVersion.extend({ sha: z.string().openapi({ description: "hex sha256 of a file in that version's manifest" }) }) },
      responses: {
        200: { description: "blob content", content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } },
        404: errors[404],
      },
    }),
    async (c) => {
      const p = c.req.valid("param");
      let body: Readable;
      try {
        body = await store.openPublishedBlob(orgOf(p.org), p.name, p.version, p.sha);
      } catch (e) {
        return notFound(c, e);
      }
      c.header("Content-Type", "application/octet-stream");
      c.header("Cache-Control", IMMUTABLE);
      return stream(c, async (s) => {
        for await (const chunk of body) await s.write(chunk as Uint8Array);
      });
    },
    (result, c) => {
      if (!result.success) return err(c, 404, "not found");
    },
  );

  return r;
}
