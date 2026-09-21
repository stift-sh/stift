// Token auth: the bearer lives in localStorage, is validated by /v1/whoami
// on login, and is dropped by any 401 so a revoked token never leaves a
// half-working UI. Components read the token through useToken() so a
// logout re-renders RequireAuth immediately.
//
// Provider auth (the server advertises auth.login): the adapter in
// ../auth owns the session and useAuth() folds both into one status. A
// pasted token wins over a provider session, here and in the API client.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { QueryCache, QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getV1Whoami } from "@stift/api-client";
import type { Whoami } from "@stift/shared";
import { type AuthProvider, loadProvider } from "../auth/provider";
import { getToken, setToken } from "./client";
import { useServerVersion } from "./version";

const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}

export function useToken(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getToken,
    () => null,
  );
}

export function logout(qc: QueryClient) {
  setToken(null);
  qc.clear();
  notify();
}

const noSession = () => null;
const noSubscribe = () => () => {};

export type Auth = {
  status: "loading" | "in" | "out";
  /** The loaded sign-in adapter, when the server names one. */
  provider: AuthProvider | null;
  /** Whether the login screen offers the pasted-token form next to it. */
  tokens: boolean;
  error: Error | null;
};

/** Signed-in state across both kinds of credential. Without a stored
 *  token it waits for /api/version, which says whether there is a
 *  provider to ask. */
export function useAuth(): Auth {
  const token = useToken();
  const version = useServerVersion();
  const login = version.data?.auth.login;
  const loaded = useQuery({
    queryKey: ["auth-provider", login?.provider],
    queryFn: () => loadProvider(login!),
    enabled: !!login,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const provider = loaded.data ?? null;
  const session = useSyncExternalStore(provider?.subscribe ?? noSubscribe, provider?.session ?? noSession, noSession);
  const tokens = !login || (version.data?.auth.kinds.includes("token") ?? true);

  // Another user or org: nothing cached is theirs.
  const qc = useQueryClient();
  const last = useRef(session);
  useEffect(() => {
    if (last.current !== null && session !== null && last.current !== session) {
      void qc.resetQueries({ predicate: (q) => q.queryKey[0] !== "version" && q.queryKey[0] !== "auth-provider" });
    }
    last.current = session;
  }, [session, qc]);

  let status: Auth["status"];
  if (token) status = "in";
  else if (version.isPending || (login && loaded.isPending)) status = "loading";
  else status = session ? "in" : "out";
  return { status, provider, tokens, error: loaded.error };
}

/** Errors from the API keep their status so the 401 handler can tell a
 *  revoked token from a flaky network. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function messageOf(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "error" in error && typeof error.error === "string") return error.error;
  return fallback;
}

async function whoami() {
  const res = await getV1Whoami().catch(() => undefined);
  if (!res) throw new ApiError(0, "could not reach the server");
  if (res.error || !res.data) throw new ApiError(res.response.status, messageOf(res.error, "unauthorized"));
  return res.data;
}

/** Creates the app's QueryClient: a 401 drops a pasted token. A provider
 *  session is left alone (its 401 is "no organization selected", which
 *  the shell answers with the org switcher, not a sign-out). */
export function createQueryClient() {
  const qc: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof ApiError && error.status === 401 && getToken()) logout(qc);
      },
    }),
  });
  return qc;
}

export function useIdentity() {
  return useQuery({ queryKey: ["whoami"], queryFn: whoami, staleTime: Infinity, retry: false });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (token: string) => {
      setToken(token.trim());
      try {
        const me = await whoami();
        qc.setQueryData(["whoami"], me);
        notify();
        return me;
      } catch (e) {
        setToken(null);
        throw e;
      }
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  const { provider } = useAuth();
  return () => {
    const viaProvider = !getToken() && provider;
    logout(qc);
    if (viaProvider) void provider.signOut();
  };
}
