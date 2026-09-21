// The operator's billing service (cloud only). Not part of the stift API:
// it lives at /api/version's cloud_api_url and takes the same bearer.
//   GET  /billing/status           -> BillingStatus
//   POST /billing/checkout|portal  -> { url } to send the browser to
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError } from "./auth";
import { bearer } from "./client";
import { useServerVersion } from "./version";

export type BillingStatus = {
  plan: "free" | "pro";
  /** Stripe's subscription status; null on the free plan. */
  status: string | null;
  /** Seats billed this period. */
  seats: number;
  current_period_end: string | null;
};

/** Leaving the app is a seam so tests can watch it happen. */
export const browser = { go: (url: string) => window.location.assign(url) };

async function call<T>(base: string, path: string, method: "GET" | "POST"): Promise<T> {
  const token = await bearer();
  const res = await fetch(base + path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch(() => undefined);
  if (!res) throw new ApiError(0, "could not reach the billing service");
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "billing request failed";
    // Never 401: a billing hiccup must not sign a token user out.
    throw new ApiError(res.status === 401 ? 403 : res.status, msg);
  }
  return body as T;
}

export function useBillingStatus() {
  const base = useServerVersion().data?.cloud_api_url;
  return useQuery({
    queryKey: ["billing", base],
    queryFn: () => call<BillingStatus>(base!, "/billing/status", "GET"),
    enabled: !!base,
  });
}

/** Starts a Stripe checkout or customer-portal session and goes there. */
export function useBillingRedirect(kind: "checkout" | "portal") {
  const base = useServerVersion().data?.cloud_api_url;
  return useMutation({
    mutationFn: () => call<{ url: string }>(base!, `/billing/${kind}`, "POST"),
    onSuccess: ({ url }) => browser.go(url),
  });
}
