import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: { url: process.env.STIFT_DATABASE_URL ?? "postgres://stift:stift@localhost:5432/stift" },
});
