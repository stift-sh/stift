// `pnpm db:migrate`: apply pending migrations to DATABASE_URL.
import { connect, runMigrations } from "./client.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const { db, pool } = connect(url);
await runMigrations(db);
await pool.end();
console.log("migrations applied");
