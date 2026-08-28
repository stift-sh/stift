import type { Role } from "../db/schema.js";

/** The authenticated caller: a user acting in one org with one role.
 *  `orgId` is "" on single-org self-hosted servers; every storage call is
 *  scoped by it. `id` is the token that authenticated. `admin` is derived
 *  from `role` and stays until web and CLI read `role` (skills-registry-3,
 *  item 7). */
export type Identity = {
  id: string;
  userId: string;
  orgId: string;
  name: string;
  role: Role;
  admin: boolean;
};

export const identity = (i: Omit<Identity, "admin">): Identity => ({ ...i, admin: i.role === "admin" });
