// Public sharing: what the org publishes as `@<slug>/<name>` (admins
// publish, hide and restore; every member reads). The list is one query
// for the whole org and pages pick their skill out of it.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteV1PublishedByName, getV1Published, postV1Published, postV1PublishedByNameRestore } from "@stift/api-client";
import type { PublishRequest, PublishedSkillDetail, PublishedVersion } from "@stift/shared";
import { unwrap } from "./unwrap";
import "./client";

export function usePublished(enabled = true) {
  return useQuery({
    queryKey: ["published"],
    queryFn: () => unwrap<PublishedSkillDetail[]>(getV1Published(), "could not load published skills"),
    enabled,
  });
}

/** The published skill an org unit is shared as, if any. A unit maps to
 *  at most one public name. */
export function publishedFor(list: PublishedSkillDetail[] | undefined, unit: { agent: string; name: string }): PublishedSkillDetail | undefined {
  return list?.find((p) => p.agent === unit.agent && p.unit === unit.name);
}

/** `stift skills install @org/name`, with `--registry` when this server
 *  is not the default registry the CLI would look at anyway. */
export function installCommand(ref: string, origin = typeof window !== "undefined" ? window.location.origin : ""): string {
  const registry = origin && origin !== "https://app.stift.sh" ? ` --registry ${origin}` : "";
  return `stift skills install ${ref}${registry}`;
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["published"] });
    // The first publish locks the org slug.
    void qc.invalidateQueries({ queryKey: ["org"] });
  };
}

export function usePublishSkill() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (body: PublishRequest) => unwrap<PublishedVersion>(postV1Published({ body }), "could not publish"),
    onSuccess: done,
  });
}

export type PublishedTarget = { name: string; version?: number };

/** Hide one version, or the whole skill without a version. */
export function useUnpublish() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ name, version }: PublishedTarget) =>
      unwrap<void>(deleteV1PublishedByName({ path: { name }, query: version ? { version } : {} }), "could not unpublish"),
    onSuccess: done,
  });
}

export function useRestore() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ name, version }: PublishedTarget) =>
      unwrap<void>(postV1PublishedByNameRestore({ path: { name }, query: version ? { version } : {} }), "could not restore"),
    onSuccess: done,
  });
}
