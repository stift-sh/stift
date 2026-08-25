import type { Db } from "../db/client.js";
import { chain, type Authenticator } from "./authenticator.js";
import { TokenAuthenticator } from "./tokens.js";

export type AuthConfig = { authenticator: Authenticator; local: boolean };

/** STIFT_AUTH selects the authenticator(s), comma-separated; unset means
 *  `local`. Only `local` exists today; `jwt` arrives with the cloud rebuild. */
export function authFromEnv(db: Db, value = process.env.STIFT_AUTH ?? "local"): AuthConfig {
  const names = value.split(",").map((s) => s.trim()).filter(Boolean);
  const auths: Authenticator[] = [];
  for (const n of names) {
    if (n === "local") auths.push(new TokenAuthenticator(db));
    else throw new Error(`STIFT_AUTH: unsupported authenticator "${n}" (supported: local)`);
  }
  if (auths.length === 0) throw new Error("STIFT_AUTH: at least one authenticator required");
  return { authenticator: auths.length === 1 ? auths[0]! : chain(...auths), local: names.includes("local") };
}
