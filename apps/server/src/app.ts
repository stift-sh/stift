import { OpenAPIHono } from "@hono/zod-openapi";
import { health } from "./routes/health.js";

export const API_VERSION = 1;

/** Builds the HTTP app. Kept separate from main.ts so tests and the
 *  OpenAPI emitter can construct it without starting a listener. */
export function createApp(opts: { version: string }) {
  const app = new OpenAPIHono();
  app.route("/", health(opts));

  app.doc("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "stift", version: opts.version },
  });
  return app;
}
export type App = ReturnType<typeof createApp>;
