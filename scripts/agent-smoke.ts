/**
 * Sends one or more messages through the real agent stack — real model, real
 * database, real tools — without going through Telegram.
 *
 * Useful for checking a new tool end to end before wiring it to the chat, and
 * for reading the token accounting of a turn. It costs actual API credits, so
 * it is a manual script and not part of `npm test`.
 *
 *   npx tsx --env-file-if-exists=.env scripts/agent-smoke.ts "create project Atlas"
 *
 * Point DATABASE_URL at a scratch database to avoid writing real data.
 */
import { loadConfig } from "../src/config/index.js";
import { createLogger } from "../src/observability/logger.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createAnthropicProvider } from "../src/agent/providers/anthropic.js";
import { createAgent } from "../src/agent/agent.js";
import { createToolRegistry } from "../src/agent/tool-registry.js";
import { createProjectTools } from "../src/agent/tools/projects.js";
import { createProjectsRepository } from "../src/db/repositories/projects.js";
import { createProjectsService } from "../src/domain/projects/service.js";

const messages = process.argv.slice(2);
if (messages.length === 0) {
  console.error('Usage: agent-smoke.ts "first message" ["second message" ...]');
  process.exit(1);
}

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const database = createDb(config.DATABASE_URL);

await database.ping();
await runMigrations(database.db);

const projectsService = createProjectsService(createProjectsRepository(database.db));
const tools = createToolRegistry(createProjectTools(projectsService, config.TZ), logger);
const agent = createAgent({
  provider: createAnthropicProvider({
    apiKey: config.ANTHROPIC_API_KEY,
    model: config.ANTHROPIC_MODEL,
  }),
  tools,
  logger,
  timeZone: config.TZ,
});

try {
  for (const text of messages) {
    console.log(`\n> ${text}`);
    console.log(`< ${await agent.handleMessage({ chatId: "smoke", text })}`);
  }
} finally {
  await database.close();
}
