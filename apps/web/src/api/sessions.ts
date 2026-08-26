// Sessions: list (server-side filters), detail, delete, archive download.
// Every failure becomes an ApiError so the QueryCache's 401 handler signs out.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteV1SessionsById, getV1Sessions, getV1SessionsById, getV1SessionsByIdArchive } from "@stift/api-client";
import type { Session } from "@stift/shared";
import { unwrap } from "./unwrap";
import "./client";

export type SessionFilter = { agent?: string; project?: string; host?: string; q?: string };

/** Drops empty filter values so the query key and the URL stay canonical. */
export function cleanFilter(f: SessionFilter): SessionFilter {
  const out: SessionFilter = {};
  for (const k of ["agent", "project", "host", "q"] as const) {
    const v = f[k]?.trim();
    if (v) out[k] = v;
  }
  return out;
}

export function useSessions(filter: SessionFilter) {
  const query = cleanFilter(filter);
  return useQuery({
    queryKey: ["sessions", query],
    queryFn: () => unwrap<Session[]>(getV1Sessions({ query }), "could not list sessions"),
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: ["sessions", "detail", id],
    queryFn: () => unwrap<Session>(getV1SessionsById({ path: { id } }), "session not found"),
    retry: false,
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap<void>(deleteV1SessionsById({ path: { id } }), "could not delete session"),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: ["sessions", "detail", id] });
      void qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}

/** Fetches the archive with the bearer and hands it to the browser as a
 *  download. A plain href cannot carry the Authorization header. */
export async function downloadArchive(id: string): Promise<void> {
  const blob = await unwrap<Blob>(getV1SessionsByIdArchive({ path: { id }, parseAs: "blob" }), "could not download archive");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${id}.tar.gz`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
