import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import type { Member, Org, Version, Whoami } from "@stift/shared";

export const version: Version = { version: "test", api: 1, features: [] };
export const org = { id: "", slug: "default", name: "Acme" };
export const admin: Whoami = { name: "root", admin: true, role: "admin", user: { id: "u-root", name: "root" }, org };
export const member: Whoami = { name: "dev-laptop", admin: false, role: "member", user: { id: "u-dev", name: "dev" }, org };
export const orgOverview: Org = { ...org, limits: { skills: null, storage_bytes: null, seats: null }, usage: { skills: 2, storage_bytes: 2048, seats: 2 } };
export const members: Member[] = [
  { id: "u-root", name: "root", email: null, role: "admin", created_at: "2026-08-20T10:00:00Z", tokens: 1 },
  { id: "u-dev", name: "dev", email: "dev@acme.test", role: "member", created_at: "2026-08-27T10:00:00Z", tokens: 2 },
];
export const unauthorized = () => HttpResponse.json({ error: "invalid token" }, { status: 401 });

/** Default handlers: any bearer is accepted as the admin identity. */
export const handlers = [
  http.get("*/api/version", () => HttpResponse.json(version)),
  http.get("*/v1/whoami", ({ request }) =>
    request.headers.get("authorization")?.startsWith("Bearer stf_") ? HttpResponse.json(admin) : unauthorized(),
  ),
  http.get("*/v1/sessions", () => HttpResponse.json([])),
  http.get("*/v1/bundles", () => HttpResponse.json([])),
  http.get("*/v1/org", () => HttpResponse.json(orgOverview)),
  http.get("*/v1/members", () => HttpResponse.json(members)),
  http.get("*/v1/installs", () => HttpResponse.json([])),
];
export const server = setupServer(...handlers);
export { http, HttpResponse };
