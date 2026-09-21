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
if (auth.bootstrap) await bootstrap(db);
const limits = limitsFromEnv();
const features = (process.env.STIFT_FEATURES ?? "").split(",").map((f) => f.trim()).filter(Boolean);
const registryEnv = process.env.STIFT_REGISTRY ?? "public";
if (registryEnv !== "public" && registryEnv !== "off") throw new Error(`STIFT_REGISTRY: want "public" or "off", got "${registryEnv}"`);
const registry = registryEnv === "public";
const serviceToken = process.env.STIFT_SERVICE_TOKEN || undefined;
if (serviceToken && serviceToken.length < 32) throw new Error("STIFT_SERVICE_TOKEN: expected at least 32 characters");
const cloudApiUrl = (process.env.STIFT_CLOUD_API_URL || "").replace(/\/+$/, "") || undefined;
const webDir = await findWebDir();
if (!webDir) console.log("no web bundle found (STIFT_WEB_DIR); serving the API only");
const store = new PgStore(db, new BlobStore(blobConfigFromEnv()));

serve({ fetch: createApp({ version, auth: auth.authenticator, store, db, limits, features, authInfo: auth.info, cloudApiUrl, webDir: webDir ?? undefined, registry, serviceToken }).fetch, port }, (info) => {
  console.log(`stift server ${version} listening on :${info.port}`);
});
