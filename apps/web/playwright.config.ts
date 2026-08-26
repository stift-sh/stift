import { defineConfig } from "@playwright/test";

// Smoke against a running server (scripts/with-server.sh exports
// STIFT_TEST_SERVER and STIFT_TEST_TOKEN). Chromium only.
export default defineConfig({
  testDir: "e2e",
  use: { baseURL: process.env.STIFT_TEST_SERVER ?? "http://localhost:8580" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  reporter: "list",
});
