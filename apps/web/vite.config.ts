import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxies API paths to a locally running server (docker compose up -d,
// or `pnpm dev` in apps/server). In production the server serves dist/ itself.
const server = process.env.STIFT_SERVER_URL ?? "http://localhost:8580";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/v1": server, "/api": server, "/healthz": server },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
