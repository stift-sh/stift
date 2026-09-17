// The caller's org with its limits and usage, and what members pulled.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getV1Installs, getV1Org, patchV1Org } from "@stift/api-client";
import type { Install, Org, OrgUpdateRequest } from "@stift/shared";
import { unwrap } from "./unwrap";
import "./client";

export function useOrg() {
  return useQuery({ queryKey: ["org"], queryFn: () => unwrap<Org>(getV1Org(), "could not load the org") });
}

/** Admins: rename the org or set its slug (the `@slug/…` namespace). */
export function useUpdateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OrgUpdateRequest) => unwrap<Org>(patchV1Org({ body }), "could not update the org"),
    onSuccess: (org) => {
      qc.setQueryData(["org"], org);
      // whoami carries the org name and slug too.
      void qc.invalidateQueries({ queryKey: ["whoami"] });
    },
  });
}

export function useInstalls(unit: { agent: string; name: string }, enabled = true) {
  return useQuery({
    queryKey: ["installs", unit.agent, unit.name],
    queryFn: () => unwrap<Install[]>(getV1Installs({ query: unit }), "could not load pulls"),
    enabled,
  });
}
