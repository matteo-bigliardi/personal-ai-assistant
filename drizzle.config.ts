import { defineConfig } from "drizzle-kit";

// Only used by the drizzle-kit CLI (`npm run db:generate`) to diff the schema.
// Applying migrations at runtime goes through src/db/migrate.ts instead, so the
// production image does not need drizzle-kit.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
