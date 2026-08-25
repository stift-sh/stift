import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export function connect(url: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url });
  return { db: drizzle(pool, { schema }), pool };
}

/** Applies the SQL migrations in src/db/migrations (shipped alongside the
 *  compiled output, so this works from both src and dist). */
export async function runMigrations(db: Db) {
  const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
  await migrate(db, { migrationsFolder });
}
