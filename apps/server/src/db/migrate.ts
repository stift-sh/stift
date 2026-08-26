// `pnpm db:migrate`: apply pending migrations to STIFT_DATABASE_URL.
import { connect, runMigrations } from "./client.js";

const url = process.env.STIFT_DATABASE_URL;
if (!url) {
  console.error("STIFT_DATABASE_URL is not set");
  process.exit(1);
}
const { db, pool } = connect(url);
await runMigrations(db);
await pool.end();
console.log("migrations applied");
