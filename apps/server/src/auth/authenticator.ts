import type { Identity } from "./identity.js";

/** Verifies a raw bearer token. Returns null for "not mine / invalid" so
 *  implementations can be chained. */
export interface Authenticator {
  authenticate(raw: string): Promise<Identity | null>;
}

/** First authenticator that returns an identity wins. */
export function chain(...auths: Authenticator[]): Authenticator {
  return {
    async authenticate(raw) {
      for (const a of auths) {
        const id = await a.authenticate(raw);
        if (id) return id;
      }
      return null;
    },
  };
}
