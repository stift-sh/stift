// Tokens: list, create (secret returned once), revoke. Admin only.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteV1TokensById, getV1Tokens, postV1Tokens } from "@stift/api-client";
import type { TokenCreated, TokenCreateRequest, TokenInfo } from "@stift/shared";
import { unwrap } from "./unwrap";
import "./client";

export function useTokens() {
  return useQuery({
    queryKey: ["tokens"],
    queryFn: () => unwrap<TokenInfo[]>(getV1Tokens(), "could not list tokens"),
  });
}

export function useCreateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TokenCreateRequest) => unwrap<TokenCreated>(postV1Tokens({ body }), "could not create token"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tokens"] }),
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap<void>(deleteV1TokensById({ path: { id } }), "could not revoke token"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tokens"] }),
  });
}
