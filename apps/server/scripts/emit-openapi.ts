// Writes openapi.gen.json next to package.json. Runs as part of `build`;
// packages/api-client and cli/internal/api generate from this file.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const app = createApp({ version: "0.0.0" });
const doc = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "stift", version: "0.0.0" } });
// Hono's `{name}{.+}` (multi-segment param) is not OpenAPI syntax.
doc.paths = Object.fromEntries(Object.entries(doc.paths ?? {}).map(([k, v]) => [k.replace(/\{\.\+\}/g, ""), v]));
const out = fileURLToPath(new URL("../../openapi.gen.json", import.meta.url));
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${out}`);
