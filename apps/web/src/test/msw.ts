import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import type { Version, Whoami } from "@stift/shared";

export const version: Version = { version: "test", api: 1, features: [] };
export const admin: Whoami = { name: "root", admin: true };
export const unauthorized = () => HttpResponse.json({ error: "invalid token" }, { status: 401 });

/** Default handlers: any bearer is accepted as the admin identity. */
export const handlers = [
  http.get("*/api/version", () => HttpResponse.json(version)),
  http.get("*/v1/whoami", ({ request }) =>
    request.headers.get("authorization")?.startsWith("Bearer stf_") ? HttpResponse.json(admin) : unauthorized(),
  ),
];
export const server = setupServer(...handlers);
export { http, HttpResponse };
