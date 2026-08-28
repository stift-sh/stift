import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { orgs } from "../db/schema.js";
import { createToken, hasTokens, registerToken } from "./tokens.js";

/** The single org of a self-hosted server. Its id is "" so rows written
 *  before orgs existed already belong to it. */
export const DEFAULT_ORG = "";

/** Ensures the default org exists. Name from STIFT_ORG_NAME (first start
 *  only; rename via the API later). Safe to run on every start. */
export async function ensureDefaultOrg(db: Db, env: NodeJS.ProcessEnv = process.env) {
  await db
    .insert(orgs)
    .values({ id: DEFAULT_ORG, slug: "default", name: env.STIFT_ORG_NAME ?? "Default" })
    .onConflictDoNothing();
  return (await db.query.orgs.findFirst({ where: eq(orgs.id, DEFAULT_ORG) }))!;
}

/** Ensures a self-hosted server has its default org and an admin token.
 *  Mirrors the former cmd_serve.go: STIFT_ADMIN_TOKEN is registered
 *  idempotently (as user `env-admin`); otherwise an admin token is minted on
 *  first start and printed once. Safe to run on every start. */
export async function bootstrap(db: Db, env: NodeJS.ProcessEnv = process.env, out = console.log) {
  await ensureDefaultOrg(db, env);
  const envTok = env.STIFT_ADMIN_TOKEN;
  if (envTok) {
    await registerToken(db, DEFAULT_ORG, envTok, "env-admin", true);
    out("admin token from STIFT_ADMIN_TOKEN registered");
    return;
  }
  if (await hasTokens(db, DEFAULT_ORG)) return;
  const { raw } = await createToken(db, DEFAULT_ORG, "admin", true);
  out(`
┌────────────────────────────────────────────────────────────────────────┐
│ First start: admin token created (shown once, store it somewhere safe) │
└────────────────────────────────────────────────────────────────────────┘

  ${raw}

Connect a client with:

  stift login http://<this-host>:8580 --token ${raw}
`);
}
