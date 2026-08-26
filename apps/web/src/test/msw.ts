import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import type { Version } from "@stift/shared";

export const version: Version = { version: "test", api: 1, features: [] };

export const handlers = [http.get("*/api/version", () => HttpResponse.json(version))];
export const server = setupServer(...handlers);
export { http, HttpResponse };
