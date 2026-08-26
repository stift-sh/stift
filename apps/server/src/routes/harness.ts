// Shared HTTP test harness: port of newTestServer/request/pushSession in
// cli/engine/server/server_test.go. Needs the docker-compose services;
// suites skip themselves when STIFT_TEST_DATABASE_URL is unset.
import { sql } from "drizzle-orm";
import type { PushMeta } from "@stift/shared";
import { createApp, type App } from "../app.js";
import { authFromEnv } from "../auth/config.js";
import { createToken } from "../auth/tokens.js";
import { connect, runMigrations, type Db } from "../db/client.js";
import { DEFAULT_LIMITS, type Limits } from "../limits.js";
import { BlobStore } from "../storage/blobs.js";
import { PgStore } from "../storage/store.js";

export const dbUrl = process.env.STIFT_TEST_DATABASE_URL;
export const skip = dbUrl ? false : "STIFT_TEST_DATABASE_URL not set";

export type TestApp = { app: App; admin: string; db: Db; close: () => Promise<void> };

/** Empties every table, like a fresh data dir per Go test. */
export const resetDb = (db: Db) => db.execute(sql`truncate sessions, blobs, bundles, bundle_versions`);

export async function createTestApp(limits: Partial<Limits> = {}): Promise<TestApp> {
  const conn = connect(dbUrl!);
  await runMigrations(conn.db);
  await conn.db.execute(sql`truncate sessions, blobs, bundles, bundle_versions, tokens`);
  const blobs = new BlobStore({
    bucket: process.env.STIFT_S3_BUCKET ?? "stift",
    endpoint: process.env.STIFT_S3_ENDPOINT ?? "http://localhost:9000",
    region: process.env.STIFT_S3_REGION ?? "us-east-1",
    accessKeyId: process.env.STIFT_S3_ACCESS_KEY ?? "stift",
    secretAccessKey: process.env.STIFT_S3_SECRET_KEY ?? "stiftstift",
    forcePathStyle: true,
    prefix: "test",
  });
  const { raw: admin } = await createToken(conn.db, "", "admin", true);
  const app = createApp({
    version: "test",
    auth: authFromEnv(conn.db, "local").authenticator,
    store: new PgStore(conn.db, blobs),
    db: conn.db,
    limits: { ...DEFAULT_LIMITS, ...limits },
  });
  return { app, admin, db: conn.db, close: () => conn.pool.end() };
}

export function req(app: App, method: string, path: string, token?: string, body?: BodyInit, contentType?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (contentType) headers["Content-Type"] = contentType;
  return app.request(path, { method, headers, body });
}

export const testMeta = (): PushMeta => ({
  key: "host/claude/abc",
  agent: "claude",
  session_id: "abc",
  host: "host",
  base: "home",
  files: 1,
  mod_time: new Date().toISOString(),
});

/** Multipart push with `meta` before `archive`, as the CLI sends it. */
export function pushSession(app: App, token: string, meta: PushMeta, payload: Uint8Array) {
  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  form.append("archive", new Blob([new Uint8Array(payload).buffer as ArrayBuffer], { type: "application/gzip" }), "archive.tar.gz");
  return req(app, "POST", "/v1/sessions", token, form);
}
