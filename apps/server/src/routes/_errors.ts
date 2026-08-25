import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError } from "@stift/shared";

/** `{"error": msg}` with the exact Go server wording; the CLI prints it. */
export const err = (c: Context, status: ContentfulStatusCode, error: string) => c.json({ error }, status);

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
