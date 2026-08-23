import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./observability/logger.js";
import { createAnthropicProvider } from "./agent/providers/anthropic.js";
import { createAgent } from "./agent/agent.js";
import { createTelegramBot } from "./channels/telegram/bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const provider = createAnthropicProvider({
    apiKey: config.ANTHROPIC_API_KEY,
    model: config.ANTHROPIC_MODEL,
  });
  const agent = createAgent(provider, logger);

  const bot = createTelegramBot({
    token: config.TELEGRAM_BOT_TOKEN,
    allowedUserIds: config.TELEGRAM_ALLOWED_USER_IDS,
    agent,
    logger,
  });

  // Minimal HTTP surface: health check only (Telegram uses long polling in V1).
  const http = new Hono();
  http.get("/health", (c) => c.json({ status: "ok", ts: new Date().toISOString() }));

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
