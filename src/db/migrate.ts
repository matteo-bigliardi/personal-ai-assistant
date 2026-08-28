import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Database } from "./client.js";
import { loadConfig } from "../config/index.js";
import { createLogger } from "../observability/logger.js";

// Both src/db/migrate.ts and dist/db/migrate.js sit two levels below the
// project root, where the generated `drizzle/` folder lives.
const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** Standalone entry point: `npm run db:migrate`. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const handle = createDb(config.DATABASE_URL);
  try {
    await runMigrations(handle.db);
    logger.info("db.migrated", { folder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}

// Only run when invoked directly, not when imported by the app. Comparing
// filesystem paths (rather than URLs) keeps this correct on Windows too.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
