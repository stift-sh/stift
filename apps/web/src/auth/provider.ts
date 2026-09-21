// Sign-in through an identity provider. The server names the adapter on
// /api/version (auth.login); each one is a dynamic import, so a self-host
// bundle never fetches the Clerk SDK. The API client asks the active
// provider for a token per request (api/client.ts).
import type { ComponentType } from "react";
import type { VersionAuth } from "@stift/shared";

export type Login = NonNullable<VersionAuth["login"]>;

export type AuthProvider = {
  /** Identifies the signed-in user and active org; null when signed out.
   *  A change means every cached response belongs to someone else. */
  session(): string | null;
  /** A fresh bearer for the API; providers cache and refresh it. */
  getToken(): Promise<string | null>;
  signOut(): Promise<void>;
  subscribe(cb: () => void): () => void;
  SignIn: ComponentType;
  OrgSwitcher: ComponentType | null;
};

let active: AuthProvider | null = null;
let loading: Promise<AuthProvider> | null = null;

export function activeProvider(): AuthProvider | null {
  return active;
}

/** Loads the adapter once; later calls (the query cache is cleared on
 *  sign-out) get the same instance. */
export function loadProvider(login: Login): Promise<AuthProvider> {
  loading ??= (login.provider === "clerk" ? import("./clerk") : import("./test"))
    .then((m) => m.create(login))
    .then((p) => (active = p));
  return loading;
}

/** Tests only: forget the loaded adapter. */
export function resetProvider() {
  active = null;
  loading = null;
}
