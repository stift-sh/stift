import { ApiError } from "./auth";

type Result<T> = { data?: T; error?: unknown; response: Response };

/** Turns a HeyAPI result into data or an ApiError (so the QueryCache's
 *  401 handler signs out), using the server's `error` wording when present. */
export async function unwrap<T>(call: Promise<Result<T>>, fallback: string): Promise<T> {
  const res = await call.catch(() => undefined);
  if (!res) throw new ApiError(0, "could not reach the server");
  if (res.error !== undefined || (res.data === undefined && res.response.status !== 204)) {
    const err = res.error;
    const msg = err && typeof err === "object" && "error" in err && typeof err.error === "string" ? err.error : fallback;
    throw new ApiError(res.response.status, msg);
  }
  return res.data as T;
}
