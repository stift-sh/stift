import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { bootstrap } from "./auth/bootstrap.js";
import { authFromEnv } from "./auth/config.js";
import { connect, runMigrations } from "./db/client.js";

const version = process.env.STIFT_VERSION ?? "dev";
const port = Number(process.env.PORT ?? 8580);
const dbUrl = process.env.STIFT_DATABASE_URL;
if (!dbUrl) throw new Error("STIFT_DATABASE_URL is required");

const { db } = connect(dbUrl);
await runMigrations(db);
const auth = authFromEnv(db);
if (auth.local) await bootstrap(db);

serve({ fetch: createApp({ version, auth: auth.authenticator }).fetch, port }, (info) => {
  console.log(`stift server ${version} listening on :${info.port}`);
});
