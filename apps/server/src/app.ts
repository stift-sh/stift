import { OpenAPIHono } from "@hono/zod-openapi";
import type { Authenticator } from "./auth/authenticator.js";
import { bearer, type AuthEnv } from "./auth/middleware.js";
import { blobs } from "./routes/blobs.js";
import { bundles } from "./routes/bundles.js";
import { sessions } from "./routes/sessions.js";
import { health } from "./routes/health.js";
import { installsRoutes } from "./routes/installs.js";
import { members } from "./routes/members.js";
import { org } from "./routes/org.js";
import { published } from "./routes/published.js";
import { registry } from "./routes/registry.js";
import { tokens } from "./routes/tokens.js";
import { whoami } from "./routes/whoami.js";
import type { Store } from "./storage/store.js";
import type { Db } from "./db/client.js";
import { DEFAULT_LIMITS, type Limits } from "./limits.js";
import { web } from "./web.js";

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
  /** Feature flags advertised on /api/version; the web app shows cloud-only
   *  screens only when the server lists them. */
  features?: string[];
  /** Directory holding the built web app (index.html + assets). When unset the
   *  server is API-only and unknown paths 404. */
  webDir?: string;
  /** The public, unauthenticated registry under `/v1/registry` (STIFT_REGISTRY).
   *  Off: those routes 404 and publishing is refused. Default on. */
  registry?: boolean;
};

const denyAll: Authenticator = { authenticate: async () => null };

/** Stand-in for a dependency the OpenAPI emitter does not provide: routes
 *  still register, any call throws. */
function unavailable<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get() {
      throw new Error(`${what} not configured`);
    },
  });
}

/** Builds the HTTP app. Kept separate from main.ts so tests and the
 *  OpenAPI emitter can construct it without starting a listener. */
export function createApp(opts: AppOptions) {
  const app = new OpenAPIHono<AuthEnv>();
  const registryOn = opts.registry ?? true;
  const features = [...(opts.features ?? [])];
  if (registryOn && !features.includes("registry")) features.push("registry");
  app.route("/", health({ ...opts, features }));

  const store = opts.store ?? unavailable<Store>("store");
  // Public and read-only, so mounted ahead of `bearer`.
  if (registryOn) app.route("/", registry(store));

  app.use("/v1/*", bearer(opts.auth ?? denyAll));
  app.route("/", whoami(opts.db));
  const db = opts.db ?? unavailable<Db>("database");
  const limits = opts.limits ?? DEFAULT_LIMITS;
  app.route("/", sessions(store, limits));
  app.route("/", blobs(store, limits));
  app.route("/", bundles(store));
  app.route("/", published(store, registryOn));

  app.route("/", tokens(db));
  app.route("/", org(db));
  app.route("/", members(db));
  app.route("/", installsRoutes(db));

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "stift access token (stf_…)",
  });
  app.doc("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "stift", version: opts.version },
  });
  if (opts.webDir) app.route("/", web(opts.webDir));
  return app;
}
export type App = ReturnType<typeof createApp>;
