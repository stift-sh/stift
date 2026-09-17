// The caller's org with its limits and usage, and what members pulled.
import { useQuery } from "@tanstack/react-query";
import { getV1Installs, getV1Org } from "@stift/api-client";
import type { Install, Org } from "@stift/shared";
import { unwrap } from "./unwrap";
import "./client";

export function useOrg() {
  return useQuery({ queryKey: ["org"], queryFn: () => unwrap<Org>(getV1Org(), "could not load the org") });
}

export function useInstalls(unit: { agent: string; name: string }, enabled = true) {
  return useQuery({
    queryKey: ["installs", unit.agent, unit.name],
    queryFn: () => unwrap<Install[]>(getV1Installs({ query: unit }), "could not load pulls"),
    enabled,
  });
}
