// The only place the app configures the generated client. Everything else
// imports operations from @stift/api-client and goes through this instance.
import { client } from "@stift/api-client";
import { activeProvider } from "../auth/provider";

const TOKEN_KEY = "stift.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable: session-only auth
  }
}

/** The bearer for this request: a pasted token when there is one, else
 *  whatever the identity provider hands out right now. */
export async function bearer(): Promise<string | undefined> {
  return getToken() ?? (await activeProvider()?.getToken()) ?? undefined;
}

client.setConfig({
  baseUrl: typeof window !== "undefined" ? window.location.origin : "http://localhost",
  auth: bearer,
});

export { client };
