import { existsSync } from "node:fs";

/**
 * Integration tests need real connection details. Node can read a dotenv file
 * natively, so tests pick up the same `.env` the app uses without adding a
 * dependency. Unit tests do not depend on it being present.
 */
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
