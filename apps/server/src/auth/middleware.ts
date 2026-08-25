import type { Context, MiddlewareHandler } from "hono";
import type { Authenticator } from "./authenticator.js";
import type { Identity } from "./identity.js";

export type AuthEnv = { Variables: { identity: Identity } };

const err = (c: Context, status: 401 | 403, error: string) => c.json({ error }, status);

/** Resolves `Authorization: Bearer …` into c.var.identity. Error bodies match
 *  the Go server verbatim: the CLI prints them. */
export function bearer(auth: Authenticator): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const raw = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!raw) return err(c, 401, "missing bearer token");
    const id = await auth.authenticate(raw);
    if (!id) return err(c, 401, "invalid token");
    c.set("identity", id);
    await next();
  };
}

export const requireAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.var.identity.admin) return err(c, 403, "admin token required");
  await next();
};
