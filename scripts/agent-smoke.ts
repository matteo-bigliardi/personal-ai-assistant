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
import { createTaskTools } from "../src/agent/tools/tasks.js";
import { createTimeTools } from "../src/agent/tools/time.js";
import { createReminderTools } from "../src/agent/tools/reminders.js";
import { createCalendarTools } from "../src/agent/tools/calendar.js";
import { createProjectsRepository } from "../src/db/repositories/projects.js";
import { createTasksRepository } from "../src/db/repositories/tasks.js";
import { createWorkSessionsRepository } from "../src/db/repositories/work-sessions.js";
import { createRemindersRepository } from "../src/db/repositories/reminders.js";
import { createProjectsService } from "../src/domain/projects/service.js";
import { createTasksService } from "../src/domain/tasks/service.js";
import { createTimeService } from "../src/domain/time/service.js";
import { createRemindersService } from "../src/domain/reminders/service.js";
import { createCalendarService } from "../src/domain/calendar/service.js";
import { createGoogleCalendar } from "../src/integrations/google-calendar/client.js";
import { createReminderJobs } from "../src/jobs/reminders.js";
import { createJobQueue } from "../src/jobs/queue.js";
import { createAuditRepository } from "../src/db/repositories/audit.js";
import { createAuditSink } from "../src/observability/audit.js";

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
const tasksService = createTasksService(createTasksRepository(database.db), projectsService);
const timeService = createTimeService(
  createWorkSessionsRepository(database.db),
  projectsService,
  config.TZ,
);
// Reminders are scheduled for real, but delivered to the console instead of
// Telegram: this script exists to exercise the tools, not to message anyone.
const queue = createJobQueue(config.DATABASE_URL, logger);
const jobs = createReminderJobs({
  boss: queue.boss,
  repo: createRemindersRepository(database.db),
  logger,
  delivery: {
    async deliver({ message }) {
      console.log(`
[reminder fired] ${message}`);
    },
  },
});
const remindersService = createRemindersService(
  createRemindersRepository(database.db),
  jobs.scheduler,
);

// The smoke script writes to the audit trail too: it is the cheapest way to
// see the table fill up without waiting for real chat traffic.
const audit = createAuditSink({ repo: createAuditRepository(database.db), logger });

const tools = createToolRegistry(
  [
    ...createProjectTools(projectsService, config.TZ),
    ...createTaskTools(tasksService, config.TZ),
    ...createTimeTools(timeService, config.TZ),
    ...createReminderTools(remindersService, config.TZ),
    ...(config.GOOGLE_SERVICE_ACCOUNT_KEY_FILE && config.GOOGLE_CALENDAR_ID
      ? createCalendarTools(
          createCalendarService(
            createGoogleCalendar({
              keyFile: config.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
              calendarId: config.GOOGLE_CALENDAR_ID,
            }),
          ),
          config.TZ,
        )
      : []),
  ],
  logger,
  { audit },
);
const agent = createAgent({
  provider: createAnthropicProvider({
    apiKey: config.ANTHROPIC_API_KEY,
    model: config.ANTHROPIC_MODEL,
  }),
  tools,
  logger,
  timeZone: config.TZ,
  audit,
});

await queue.start();
await jobs.start();

try {
  for (const text of messages) {
    console.log(`\n> ${text}`);
    console.log(`< ${await agent.handleMessage({ chatId: "smoke", text })}`);
  }
} finally {
  await queue.stop();
  await database.close();
}
