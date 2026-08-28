// Token auth: the bearer lives in localStorage, is validated by /v1/whoami
// on login, and is dropped by any 401 so a revoked token never leaves a
// half-working UI. Components read the token through useToken() so a
// logout re-renders RequireAuth immediately.
import { useSyncExternalStore } from "react";
import { QueryCache, QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getV1Whoami } from "@stift/api-client";
import type { Whoami } from "@stift/shared";
import { getToken, setToken } from "./client";

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

/** Creates the app's QueryClient: any 401 from any query signs out. */
export function createQueryClient() {
  const qc: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof ApiError && error.status === 401) logout(qc);
      },
    }),
  });
  return qc;
}

export function useIdentity() {
  return useQuery({ queryKey: ["whoami"], queryFn: whoami, staleTime: Infinity, retry: false });
}

/** The caller's role; servers older than roles only send `admin`. */
export const roleOf = (me: Pick<Whoami, "admin" | "role"> | undefined): "admin" | "member" | undefined =>
  me && (me.role ?? (me.admin ? "admin" : "member"));

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
  return () => logout(qc);
}
