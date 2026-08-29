import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./observability/logger.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createAnthropicProvider } from "./agent/providers/anthropic.js";
import { createAgent } from "./agent/agent.js";
import { createToolRegistry } from "./agent/tool-registry.js";
import { createProjectTools } from "./agent/tools/projects.js";
import { createProjectsRepository } from "./db/repositories/projects.js";
import { createProjectsService } from "./domain/projects/service.js";
import { createTelegramBot } from "./channels/telegram/bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  // Fail fast if Postgres is unreachable, then bring the schema up to date.
  // Single-user app: migrating on boot keeps `docker compose up` reproducible.
  const database = createDb(config.DATABASE_URL);
  await database.ping();
  await runMigrations(database.db);
  logger.info("db.ready");

  const provider = createAnthropicProvider({
    apiKey: config.ANTHROPIC_API_KEY,
    model: config.ANTHROPIC_MODEL,
  });

  // Composition root: repositories -> domain services -> typed tools. Each
  // layer only knows the one below it, so the domain stays free of Telegram
  // and of the model.
  const projectsService = createProjectsService(createProjectsRepository(database.db));
  const tools = createToolRegistry([...createProjectTools(projectsService, config.TZ)], logger);

  const agent = createAgent({
    provider,
    tools,
    logger,
    timeZone: config.TZ,
  });
  logger.info("agent.ready", { tools: tools.specs.map((t) => t.name) });

  const bot = createTelegramBot({
    token: config.TELEGRAM_BOT_TOKEN,
    allowedUserIds: config.TELEGRAM_ALLOWED_USER_IDS,
    agent,
    logger,
  });

  // Minimal HTTP surface: health check only (Telegram uses long polling in V1).
  const http = new Hono();
  http.get("/health", async (c) => {
    try {
      await database.ping();
    } catch (err) {
      logger.error("health.db_unreachable", { error: String(err) });
      return c.json({ status: "degraded", db: "unreachable" }, 503);
    }
    return c.json({ status: "ok", db: "ok", ts: new Date().toISOString() });
  });

  const server = serve({ fetch: http.fetch, port: config.HTTP_PORT }, (info) => {
    logger.info("http.listening", { port: info.port });
  });

  // Long polling. bot.start() resolves only when the bot stops.
  void bot.start({
    onStart: (me) => logger.info("telegram.started", { username: me.username }),
  });

  const shutdown = async (signal: string) => {
    logger.info("shutdown", { signal });
    await bot.stop();
    server.close();
    await database.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // Fail fast on startup errors (bad config, etc.).
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
