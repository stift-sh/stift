import type { Identity } from "./identity.js";

/** Subjects of the permission table. `ownerId` is the `user_id` of the row;
 *  null means unowned (legacy or written by a deleted user). */
export type Subject =
  | { action: "bundle.write"; scope: string; ownerId: string | null }
  | { action: "token.manage" }
  | { action: "member.manage" }
  | { action: "session.delete"; ownerId: string | null };

/**
 * The permission table of skills-registry-3 (D2), as one pure function so
 * routes share it and it is tested once. Reads are org-wide for every role
 * and never come through here.
 *
 * | action           | subject                     | member | admin |
 * |------------------|-----------------------------|--------|-------|
 * | bundle.write     | scope org                   | no     | yes   |
 * | bundle.write     | scope user, owner ≠ self    | no     | yes   |
 * | bundle.write     | scope user, own / unowned   | yes    | yes   |
 * | bundle.write     | scope project               | yes    | yes   |
 * | token.manage     | the org's tokens            | no     | yes   |
 * | member.manage    | users and roles in the org  | no     | yes   |
 * | session.delete   | owner ≠ self                | no     | yes   |
 *
 * Unowned rows are writable by any member so data from before users
 * existed does not become read-only; the first write claims them.
 */
export function can(id: Pick<Identity, "userId" | "role">, s: Subject): boolean {
  if (id.role === "admin") return true;
  switch (s.action) {
    case "bundle.write":
      if (s.scope === "org") return false;
      if (s.scope === "user") return s.ownerId === null || s.ownerId === id.userId;
      return true;
    case "token.manage":
    case "member.manage":
      return false;
    case "session.delete":
      return s.ownerId === null || s.ownerId === id.userId;
  }
}
