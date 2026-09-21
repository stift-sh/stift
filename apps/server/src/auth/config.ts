import type { Db } from "../db/client.js";
import { chain, type Authenticator } from "./authenticator.js";
import { JwtAuthenticator, jwtConfigFromEnv } from "./jwt.js";
import { TokenAuthenticator } from "./tokens.js";

/** `local`: the token routes are mounted. `bootstrap`: the server owns a
 *  default org (always with `local` alone; with `jwt` only when
 *  STIFT_JWT_ORG pins tokens to it, since a multi-org server has none). */
export type AuthConfig = { authenticator: Authenticator; local: boolean; bootstrap: boolean };

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
  return { authenticator: auths.length === 1 ? auths[0]! : chain(...auths), local, bootstrap: local && !multiOrg };
}
