import { Client } from "pg";
import { createDb, type DbHandle } from "../../../src/db/client.js";
import { runMigrations } from "../../../src/db/migrate.js";

/**
 * Integration tests run against a real Postgres, because the invariants under
 * test (the partial unique index on the running timer, the case-insensitive
 * project name index, the CHECK constraints) exist only in the database — an
 * in-memory fake would prove nothing.
 *
 * They never touch `DATABASE_URL` itself. The URL is redirected to a sibling
 * database suffixed `_test`, created on demand, so running the suite can never
 * truncate the developer's own data. When no Postgres is reachable the caller
 * skips instead of failing, so `npm test` still works with nothing running.
 */

export interface TestDb extends DbHandle {
  /** Empties every application table, preserving the schema. */
  truncate(): Promise<void>;
}

const TABLES = ["work_sessions", "tasks", "projects"];

function testDatabaseUrl(): string | undefined {
  const raw = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!raw) return undefined;
  if (process.env.TEST_DATABASE_URL) return raw;

  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, "");
  if (!name) return undefined;
  url.pathname = `/${name}_test`;
  return url.toString();
}

/** Creates the test database if it is missing. Returns false if unreachable. */
async function ensureDatabase(url: string): Promise<boolean> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ""));

  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });

  try {
    await client.connect();
  } catch {
    return false;
  }
  try {
    // Identifiers cannot be parameterised; the name is derived from our own
    // configuration, and quotes inside it are escaped.
    await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } catch (err) {
    // 42P04: already exists — the normal case after the first run.
    if ((err as { code?: string }).code !== "42P04") throw err;
  } finally {
    await client.end();
  }
  return true;
}

/** Returns a migrated, empty test database, or null when Postgres is absent. */
export async function setupTestDb(): Promise<TestDb | null> {
  const url = testDatabaseUrl();
  if (!url) return null;
  if (!(await ensureDatabase(url))) return null;

  const handle = createDb(url);
  await handle.ping();
  await runMigrations(handle.db);

  const testDb: TestDb = {
    ...handle,
    async truncate() {
      await handle.pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    },
  };
  await testDb.truncate();
  return testDb;
}
