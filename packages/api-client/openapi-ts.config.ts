import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../../apps/server/openapi.gen.json",
  output: { path: "src/generated", format: false, lint: false },
  plugins: ["@hey-api/typescript", "@hey-api/sdk", { name: "@hey-api/client-fetch" }],
});
