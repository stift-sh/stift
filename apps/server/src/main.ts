import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { bootstrap } from "./auth/bootstrap.js";
import { authFromEnv } from "./auth/config.js";
import { connect, runMigrations } from "./db/client.js";
import { limitsFromEnv } from "./limits.js";
import { BlobStore, blobConfigFromEnv } from "./storage/blobs.js";
import { PgStore } from "./storage/store.js";
import { findWebDir } from "./web.js";

const version = process.env.STIFT_VERSION ?? "dev";
const port = Number(process.env.PORT ?? 8580);
const dbUrl = process.env.STIFT_DATABASE_URL;
if (!dbUrl) throw new Error("STIFT_DATABASE_URL is required");

const { db } = connect(dbUrl);
await runMigrations(db);
const auth = authFromEnv(db);
if (auth.local) await bootstrap(db);
const limits = limitsFromEnv();
const features = (process.env.STIFT_FEATURES ?? "").split(",").map((f) => f.trim()).filter(Boolean);
const webDir = await findWebDir();
if (!webDir) console.log("no web bundle found (STIFT_WEB_DIR); serving the API only");
const store = new PgStore(db, new BlobStore(blobConfigFromEnv()));

serve({ fetch: createApp({ version, auth: auth.authenticator, store, db, limits, features, webDir: webDir ?? undefined }).fetch, port }, (info) => {
  console.log(`stift server ${version} listening on :${info.port}`);
});
