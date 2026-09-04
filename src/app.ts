import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./observability/logger.js";
import { createAuditSink } from "./observability/audit.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createAnthropicProvider } from "./agent/providers/anthropic.js";
import { createAgent } from "./agent/agent.js";
import { createToolRegistry } from "./agent/tool-registry.js";
import { createProjectTools } from "./agent/tools/projects.js";
import { createTaskTools } from "./agent/tools/tasks.js";
import { createTimeTools } from "./agent/tools/time.js";
import { createReminderTools } from "./agent/tools/reminders.js";
import { createCalendarTools } from "./agent/tools/calendar.js";
import { createProjectsRepository } from "./db/repositories/projects.js";
import { createTasksRepository } from "./db/repositories/tasks.js";
import { createWorkSessionsRepository } from "./db/repositories/work-sessions.js";
import { createRemindersRepository } from "./db/repositories/reminders.js";
import { createAuditRepository } from "./db/repositories/audit.js";
import { createProjectsService } from "./domain/projects/service.js";
import { createTasksService } from "./domain/tasks/service.js";
import { createTimeService } from "./domain/time/service.js";
import { createRemindersService } from "./domain/reminders/service.js";
import { createCalendarService } from "./domain/calendar/service.js";
import { createGoogleCalendar } from "./integrations/google-calendar/client.js";
import { createReminderJobs, type ReminderDelivery } from "./jobs/reminders.js";
import { createAuditRetention } from "./jobs/audit-retention.js";
import { createTelegramBot } from "./channels/telegram/bot.js";
import { createTelegramReminderDelivery } from "./channels/telegram/reminder-delivery.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  // Fail fast if Postgres is unreachable, then bring the schema up to date.
  // Single-user app: migrating on boot keeps `docker compose up` reproducible.
  const database = createDb(config.DATABASE_URL);
  await database.ping();
  await runMigrations(database.db);
  logger.info("db.ready");

  // Audit is wired at the composition root and handed to the two places
  // every action passes through: the tool registry and the agent loop.
  // A failed audit write is logged and swallowed there, never propagated.
  const auditRepository = createAuditRepository(database.db);
  const audit = createAuditSink({ repo: auditRepository, logger });

  const provider = createAnthropicProvider({
    apiKey: config.ANTHROPIC_API_KEY,
    model: config.ANTHROPIC_MODEL,
  });

  // Composition root: repositories -> domain services -> typed tools. Each
  // layer only knows the one below it, so the domain stays free of Telegram
  // and of the model.
  const projectsService = createProjectsService(createProjectsRepository(database.db));
  const tasksService = createTasksService(createTasksRepository(database.db), projectsService);
  const timeService = createTimeService(
    createWorkSessionsRepository(database.db),
    projectsService,
    config.TZ,
  );
  // Reminders close a cycle the other domains do not have: the queue delivers
  // through Telegram, Telegram answers through the agent, the agent calls the
  // reminder tools, and those schedule on the queue. It is broken here, at the
  // composition root, by giving the queue a delivery that resolves the bot when
  // a reminder actually fires — by which time everything below exists.
  const remindersRepository = createRemindersRepository(database.db);
  let telegramDelivery: ReminderDelivery | undefined = undefined;
  const delivery: ReminderDelivery = {
    async deliver(input) {
      if (!telegramDelivery) throw new Error("Telegram delivery is not ready yet");
      await telegramDelivery.deliver(input);
    },
  };

  const jobs = createReminderJobs({
    connectionString: config.DATABASE_URL,
    repo: remindersRepository,
    delivery,
    logger,
  });
  const remindersService = createRemindersService(remindersRepository, jobs.scheduler);

  // Calendar is optional. Without it the assistant runs with everything else
  // and simply has no calendar tools, rather than failing to start: a missing
  // integration should not take the whole assistant down.
  const calendarTools =
    config.GOOGLE_SERVICE_ACCOUNT_KEY_FILE && config.GOOGLE_CALENDAR_ID
      ? createCalendarTools(
          createCalendarService(
            createGoogleCalendar({
              keyFile: config.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
              calendarId: config.GOOGLE_CALENDAR_ID,
            }),
          ),
          config.TZ,
        )
      : [];
  if (calendarTools.length === 0) {
    logger.warn("calendar.disabled", { reason: "GOOGLE_* not configured" });
  }

  const tools = createToolRegistry(
    [
      ...createProjectTools(projectsService, config.TZ),
      ...createTaskTools(tasksService, config.TZ),
      ...createTimeTools(timeService, config.TZ),
      ...createReminderTools(remindersService, config.TZ),
      ...calendarTools,
    ],
    logger,
    audit,
  );

  const agent = createAgent({
    provider,
    tools,
    logger,
    timeZone: config.TZ,
    audit,
  });
  logger.info("agent.ready", { tools: tools.specs.map((t) => t.name) });

  const bot = createTelegramBot({
    token: config.TELEGRAM_BOT_TOKEN,
    allowedUserIds: config.TELEGRAM_ALLOWED_USER_IDS,
    agent,
    logger,
    onSnooze: async (reminderId, minutes) => {
      await remindersService.snooze(reminderId, minutes);
    },
  });
  telegramDelivery = createTelegramReminderDelivery(bot);

  // Start the queue before reconciling it: anything that fell due while the
  // process was down goes out now, late rather than never.
  await jobs.start();
  await jobs.recover();

  const retention = createAuditRetention({
    repo: auditRepository,
    logger,
    retentionDays: config.AUDIT_RETENTION_DAYS,
  });
  retention.start();

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
    await jobs.stop();
    retention.stop();
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
