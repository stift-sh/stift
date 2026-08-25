import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError } from "@stift/shared";
import { HashMismatchError } from "../storage/blobs.js";
import { MissingBlobError, NotFoundError, StaleError } from "../storage/errors.js";

/** `{"error": msg}` with the exact Go server wording; the CLI prints it. */
export const err = <S extends ContentfulStatusCode>(c: Context, status: S, error: string) => c.json({ error }, status);

const json = (description: string) => ({ description, content: { "application/json": { schema: ApiError } } });

/** Reusable OpenAPI error responses. */
export const errors = {
  400: json("bad request"),
  401: json("missing or invalid bearer token"),
  403: json("forbidden"),
  404: json("not found"),
  409: json("conflict"),
  411: json("Content-Length required"),
  412: json("precondition failed"),
  413: json("payload too large"),
  500: json("server error"),
} as const;

/** Maps storage errors to the Go server's status codes; rethrows the rest. */
export function storeError(c: Context, e: unknown) {
  if (e instanceof NotFoundError) return err(c, 404, e.message);
  if (e instanceof StaleError) return err(c, 409, e.message);
  if (e instanceof MissingBlobError) return err(c, 412, e.message);
  if (e instanceof HashMismatchError) return err(c, 400, e.message);
  throw e;
}
