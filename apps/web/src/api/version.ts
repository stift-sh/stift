import { useQuery } from "@tanstack/react-query";
import { getApiVersion } from "@stift/api-client";
import "./client";

/** Server version and feature flags; the source of truth for which
 *  screens (cloud, marketplace) the app shows. */
export function useServerVersion() {
  return useQuery({
    queryKey: ["version"],
    queryFn: async () => {
      const { data, error } = await getApiVersion().catch(() => ({ data: undefined, error: true as const }));
      if (error || !data) throw new Error("could not reach the server");
      return data;
    },
    staleTime: Infinity,
  });
}
