// Members of the caller's org: every member may list, admins manage.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteV1MembersById, getV1Members, patchV1MembersById, postV1Members } from "@stift/api-client";
import type { Member, MemberCreated, MemberCreateRequest, Role } from "@stift/shared";
import { unwrap } from "./unwrap";
import "./client";

export function useMembers(enabled = true) {
  return useQuery({
    queryKey: ["members"],
    queryFn: () => unwrap<Member[]>(getV1Members(), "could not list members"),
    enabled,
  });
}

/** Members, tokens (a removed member's go with them) and the seat count. */
function useRefresh() {
  const qc = useQueryClient();
  return () => {
    for (const queryKey of [["members"], ["tokens"], ["org"]]) void qc.invalidateQueries({ queryKey });
  };
}

export function useAddMember() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: MemberCreateRequest) => unwrap<MemberCreated>(postV1Members({ body }), "could not add member"),
    onSuccess: refresh,
  });
}

export function useSetRole() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      unwrap<Member>(patchV1MembersById({ path: { id }, body: { role } }), "could not change role"),
    onSuccess: refresh,
  });
}

export function useRemoveMember() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => unwrap<void>(deleteV1MembersById({ path: { id } }), "could not remove member"),
    onSuccess: refresh,
  });
}
