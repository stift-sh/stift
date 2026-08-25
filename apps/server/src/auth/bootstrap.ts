import type { Db } from "../db/client.js";
import { createToken, hasTokens, registerToken } from "./tokens.js";

/** Ensures a self-hosted server has an admin token. Mirrors cmd_serve.go:
 *  STIFT_ADMIN_TOKEN is registered idempotently; otherwise an admin token is
 *  minted on first start and printed once. Safe to run on every start. */
export async function bootstrap(db: Db, env: NodeJS.ProcessEnv = process.env, out = console.log) {
  const envTok = env.STIFT_ADMIN_TOKEN;
  if (envTok) {
    await registerToken(db, "", envTok, "env-admin", true);
    out("admin token from STIFT_ADMIN_TOKEN registered");
    return;
  }
  if (await hasTokens(db, "")) return;
  const { raw } = await createToken(db, "", "admin", true);
  out(`
┌────────────────────────────────────────────────────────────────────────┐
│ First start: admin token created (shown once, store it somewhere safe) │
└────────────────────────────────────────────────────────────────────────┘

  ${raw}

Connect a client with:

  stift login http://<this-host>:8580 --token ${raw}
`);
}
