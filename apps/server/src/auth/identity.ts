/** The authenticated caller. `tenant` is "" on single-tenant self-hosted
 *  servers; every storage call is scoped by it. */
export type Identity = { id: string; tenant: string; name: string; admin: boolean };
