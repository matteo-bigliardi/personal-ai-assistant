/**
 * Runs the morning briefing right now, against real data and the real model,
 * and prints it instead of sending it to Telegram.
 *
 * The alternative is waiting until 07:30 to find out whether it works. The
 * once-a-day claim is bypassed, so this can be run repeatedly and never
 * consumes the real briefing.
 *
 *   npx tsx --env-file-if-exists=.env scripts/briefing-smoke.ts
 *
 * It costs actual API credits, so it is a manual script and not part of `npm test`.
 */
import { createBriefingWriter } from "../src/agent/briefing.js";
import { createAnthropicProvider } from "../src/agent/providers/anthropic.js";
import { loadConfig } from "../src/config/index.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createBriefingRepository } from "../src/db/repositories/briefing.js";
import { createProjectsRepository } from "../src/db/repositories/projects.js";
import { createTasksRepository } from "../src/db/repositories/tasks.js";
import { createBriefingService } from "../src/domain/briefing/service.js";
import { createCalendarService } from "../src/domain/calendar/service.js";
import { createProjectsService } from "../src/domain/projects/service.js";
import { createTasksService } from "../src/domain/tasks/service.js";
import { createGoogleCalendar } from "../src/integrations/google-calendar/client.js";
import { createBriefingJob } from "../src/jobs/briefing.js";
import { createJobQueue } from "../src/jobs/queue.js";
import { createLogger } from "../src/observability/logger.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

const database = createDb(config.DATABASE_URL);
await database.ping();
await runMigrations(database.db);

const projectsService = createProjectsService(createProjectsRepository(database.db));
const tasksService = createTasksService(createTasksRepository(database.db), projectsService);
const calendarService =
  config.GOOGLE_SERVICE_ACCOUNT_KEY_FILE && config.GOOGLE_CALENDAR_ID
    ? createCalendarService(
        createGoogleCalendar({
          keyFile: config.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
          calendarId: config.GOOGLE_CALENDAR_ID,
        }),
      )
    : undefined;

const briefingRepository = createBriefingRepository(database.db);
const briefingService = createBriefingService({
  repo: briefingRepository,
  tasks: tasksService,
  calendar: calendarService,
  // Nothing here changes the time, so the scheduler is never reached.
  scheduler: { reschedule: async () => {} },
  logger,
  timeZone: config.TZ,
});

// The queue is never started: a forced run touches the repository, the services
// and the provider, and none of those need a worker.
const queue = createJobQueue(config.DATABASE_URL, logger);
const job = createBriefingJob({
  boss: queue.boss,
  repo: briefingRepository,
  service: briefingService,
  writer: createBriefingWriter({
    provider: createAnthropicProvider({
      apiKey: config.ANTHROPIC_API_KEY,
      model: config.ANTHROPIC_MODEL,
    }),
    logger,
  }),
  delivery: {
    async deliver({ text }) {
      console.log(`\n--- briefing ---\n${text}\n----------------`);
    },
  },
  chatId: "smoke",
  timeZone: config.TZ,
  logger,
});

try {
  await briefingRepository.ensure(config.BRIEFING_TIME);
  console.log(`Scheduled at ${await briefingService.getSendAt()} (${config.TZ}).`);
  await job.run({ force: true });
} finally {
  await database.close();
}
