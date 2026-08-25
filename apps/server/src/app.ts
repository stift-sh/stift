import { OpenAPIHono } from "@hono/zod-openapi";
import type { Authenticator } from "./auth/authenticator.js";
import { bearer, type AuthEnv } from "./auth/middleware.js";
import { health } from "./routes/health.js";
import { whoami } from "./routes/whoami.js";
import type { Store } from "./storage/store.js";
import type { Db } from "./db/client.js";
import { DEFAULT_LIMITS, type Limits } from "./limits.js";

export const API_VERSION = 1;

export type AppOptions = {
  version: string;
  /** Bearer-token authenticator for /v1/*. Optional only so the OpenAPI
   *  emitter can build the app without a database. */
  auth?: Authenticator;
  /** Session, blob and bundle storage for /v1/*. Optional for the same reason. */
  store?: Store;
  /** Database handle for token management routes. Optional for the same reason. */
  db?: Db;
  limits?: Limits;
};

const denyAll: Authenticator = { authenticate: async () => null };

/** Builds the HTTP app. Kept separate from main.ts so tests and the
 *  OpenAPI emitter can construct it without starting a listener. */
export function createApp(opts: AppOptions) {
  const app = new OpenAPIHono<AuthEnv>();
  app.route("/", health(opts));

  app.use("/v1/*", bearer(opts.auth ?? denyAll));
  app.route("/", whoami());
  // Route modules (sessions, blobs, bundles, tokens) mount here; each takes
  // opts.store / opts.db and opts.limits ?? DEFAULT_LIMITS.
  void DEFAULT_LIMITS;

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "stift access token (stf_…)",
  });
  app.doc("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "stift", version: opts.version },
  });
  return app;
}
export type App = ReturnType<typeof createApp>;
