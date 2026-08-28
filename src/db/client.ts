import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Database;
  pool: Pool;
  /** Verifies the connection so startup fails fast on a bad DATABASE_URL. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string): DbHandle {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async ping() {
      await db.execute(sql`select 1`);
    },
    async close() {
      await pool.end();
    },
  };
}
