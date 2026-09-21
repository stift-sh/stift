import type { VersionAuth } from "@stift/shared";
import type { Db } from "../db/client.js";
import { chain, type Authenticator } from "./authenticator.js";
import { JwtAuthenticator, jwtConfigFromEnv } from "./jwt.js";
import { TokenAuthenticator } from "./tokens.js";

/** `local`: the token routes are mounted. `bootstrap`: the server owns a
 *  default org (always with `local` alone; with `jwt` only when
 *  STIFT_JWT_ORG pins tokens to it, since a multi-org server has none). */
export type AuthConfig = { authenticator: Authenticator; local: boolean; bootstrap: boolean; info: VersionAuth };

/** STIFT_LOGIN_PROVIDER names the web app's sign-in adapter (`clerk`, or
 *  `test` for end-to-end tests); it needs `jwt`, since the adapter's tokens
 *  are what the server then verifies. Clerk also takes
 *  STIFT_CLERK_PUBLISHABLE_KEY and, when the org claims come from a JWT
 *  template, STIFT_CLERK_JWT_TEMPLATE. */
function loginFromEnv(names: string[], env: NodeJS.ProcessEnv): VersionAuth["login"] {
  const provider = env.STIFT_LOGIN_PROVIDER || undefined;
  if (!provider) return undefined;
  if (provider !== "clerk" && provider !== "test") throw new Error(`STIFT_LOGIN_PROVIDER: unsupported provider "${provider}" (supported: clerk, test)`);
  if (!names.includes("jwt")) throw new Error("STIFT_LOGIN_PROVIDER needs jwt in STIFT_AUTH");
  if (provider === "test") return { provider };
  const key = env.STIFT_CLERK_PUBLISHABLE_KEY || undefined;
  if (!key) throw new Error("STIFT_LOGIN_PROVIDER=clerk: STIFT_CLERK_PUBLISHABLE_KEY is required");
  const template = env.STIFT_CLERK_JWT_TEMPLATE || undefined;
  return { provider, publishable_key: key, ...(template ? { jwt_template: template } : {}) };
}

/** STIFT_AUTH selects the authenticator(s), comma-separated; unset means
 *  `local`. `local` is `stf_` tokens, `jwt` is an identity provider's JWTs
 *  (see jwt.ts); `local,jwt` accepts both. */
export function authFromEnv(db: Db, value = process.env.STIFT_AUTH ?? "local", env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const names = value.split(",").map((s) => s.trim()).filter(Boolean);
  const auths: Authenticator[] = [];
  for (const n of names) {
    if (n === "local") auths.push(new TokenAuthenticator(db));
    else if (n === "jwt") auths.push(new JwtAuthenticator(db, jwtConfigFromEnv(env)));
    else throw new Error(`STIFT_AUTH: unsupported authenticator "${n}" (supported: local, jwt)`);
  }
  if (auths.length === 0) throw new Error("STIFT_AUTH: at least one authenticator required");
  const local = names.includes("local");
  const multiOrg = names.includes("jwt") && env.STIFT_JWT_ORG === undefined;
  const kinds: VersionAuth["kinds"] = [];
  if (local) kinds.push("token");
  if (names.includes("jwt")) kinds.push("jwt");
  const login = loginFromEnv(names, env);
  return { authenticator: auths.length === 1 ? auths[0]! : chain(...auths), local, bootstrap: local && !multiOrg, info: { kinds, ...(login ? { login } : {}) } };
}
