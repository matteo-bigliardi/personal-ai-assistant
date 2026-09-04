import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { BriefingData, BriefingService } from "../../src/domain/briefing/service.js";
import {
  createBriefingRepository,
  type BriefingRepository,
} from "../../src/db/repositories/briefing.js";
import { BRIEFING_QUEUE, createBriefingJob } from "../../src/jobs/briefing.js";
import { createJobQueue, type JobQueue } from "../../src/jobs/queue.js";
import { createTestLogger } from "../helpers/logger.js";
import { setupTestDb, testDatabaseUrl } from "./helpers/db.js";

/**
 * Against real pg-boss because the schedule is the thing being checked: that a
 * time change replaces the cron instead of adding a second one, and that the
 * timezone is stored with it — a cron in UTC would be an hour out for half the
 * year, which is the failure this design exists to avoid.
 */
const testDb = await setupTestDb();
const url = testDatabaseUrl();
const describeDb = testDb && url ? describe : describe.skip;

if (!testDb) {
  console.warn("[integration] no Postgres reachable — skipping briefing job tests");
}

const TZ = "Europe/Rome";
const NOW = new Date("2026-09-09T05:30:00Z");

const DATA: BriefingData = {
  date: "2026-09-09",
  events: [],
  tasks: [],
  empty: true,
  calendarUnavailable: false,
};

describeDb("briefing schedule", () => {
  let repo: BriefingRepository;
  let queue: JobQueue;
  const sent: string[] = [];

  function makeJob() {
    return createBriefingJob({
      boss: queue.boss,
      repo,
      service: {
        async collect() {
          return DATA;
        },
      } as unknown as BriefingService,
      writer: {
        async write() {
          return "buongiorno";
        },
      },
      delivery: {
        async deliver({ text }) {
          sent.push(text);
        },
      },
      chatId: "chat-1",
      timeZone: TZ,
      logger: createTestLogger(),
      now: () => NOW,
    });
  }

  beforeEach(async () => {
    await testDb?.truncate();
    if (!testDb) return;
    repo = createBriefingRepository(testDb.db);
    await repo.ensure("07:30");
    sent.length = 0;
    queue = createJobQueue(url as string, createTestLogger());
    await queue.start();
    await queue.boss.unschedule(BRIEFING_QUEUE);
  });

  afterAll(async () => {
    await queue?.stop();
    await testDb?.close();
  });

  it("installs one daily cron carrying the timezone", async () => {
    await makeJob().start("07:30");

    const schedules = await queue.boss.getSchedules(BRIEFING_QUEUE);

    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.cron).toBe("30 7 * * *");
    // Without this the briefing would drift an hour at every DST change.
    expect(schedules[0]?.timezone).toBe(TZ);
  });

  it("replaces the cron when the time changes, rather than adding one", async () => {
    const job = makeJob();
    await job.start("07:30");

    await job.scheduler.reschedule("08:05");

    const schedules = await queue.boss.getSchedules(BRIEFING_QUEUE);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.cron).toBe("5 8 * * *");
  });

  it("delivers once a day even when run twice", async () => {
    const job = makeJob();

    expect(await job.run()).toBe(true);
    expect(await job.run()).toBe(false);

    expect(sent).toEqual(["buongiorno"]);
    expect((await repo.get())?.lastSentOn).toBe("2026-09-09");
  });
});
