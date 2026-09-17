import type { Role } from "../db/schema.js";

/** The authenticated caller: a user acting in one org with one role.
 *  `orgId` is "" on single-org self-hosted servers; every storage call is
 *  scoped by it. `id` is the token that authenticated. */
export type Identity = {
  id: string;
  userId: string;
  /** Display name of the user (`name` is the token's). */
  userName: string;
  orgId: string;
  name: string;
  role: Role;
};
