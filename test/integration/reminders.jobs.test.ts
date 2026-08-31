import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createRemindersRepository,
  type RemindersRepository,
} from "../../src/db/repositories/reminders.js";
import { createReminderJobs, REMINDER_QUEUE, type ReminderJobs } from "../../src/jobs/reminders.js";
import { createTestLogger } from "../helpers/logger.js";
import { setupTestDb, testDatabaseUrl } from "./helpers/db.js";

/**
 * The acceptance criterion for this phase is "delivers reminders after a
 * restart", and that cannot be established by reasoning about the code: it
 * needs a real queue and a real database. These tests run pg-boss against the
 * test database and simulate the restart by building a second set of jobs over
 * the same rows — which is exactly what a restarted process is.
 */
const testDb = await setupTestDb();
const url = testDatabaseUrl();
const describeDb = testDb && url ? describe : describe.skip;

if (!testDb) {
  console.warn("[integration] no Postgres reachable — skipping reminder job tests");
}

const at = (iso: string) => new Date(iso);
const NOW = at("2026-08-31T10:00:00Z");
const CHAT = "chat-1";

describeDb("reminder delivery", () => {
  let repo: RemindersRepository;
  let delivered: { chatId: string; reminderId: string; message: string }[];
  const running: ReminderJobs[] = [];

  /** A fresh set of jobs over the same database — a restarted process. */
  function bootJobs(options: { failDelivery?: boolean; now?: Date } = {}): ReminderJobs {
    const jobs = createReminderJobs({
      connectionString: url as string,
      repo,
      logger: createTestLogger(),
      now: () => options.now ?? NOW,
      delivery: {
        async deliver(input) {
          if (options.failDelivery) throw new Error("telegram is down");
          delivered.push(input);
        },
      },
    });
    running.push(jobs);
    return jobs;
  }

  beforeEach(async () => {
    await testDb?.truncate();
    if (testDb) repo = createRemindersRepository(testDb.db);
    delivered = [];
  });

  afterAll(async () => {
    for (const jobs of running) await jobs.stop();
    await testDb?.close();
  });

  const make = (dueAt: Date) => repo.create({ chatId: CHAT, message: "check the build", dueAt });

  it("delivers a reminder that fell due while the process was down", async () => {
    // Written before the "restart", with a due time already in the past.
    const reminder = await make(at("2026-08-31T09:00:00Z"));

    const jobs = bootJobs();
    await jobs.start();
    const result = await jobs.recover();

    expect(result.delivered).toBe(1);
    expect(delivered).toEqual([
      { chatId: CHAT, reminderId: reminder.id, message: "check the build" },
    ]);
    expect((await repo.findById(reminder.id))?.status).toBe("delivered");
  });

  it("does not deliver the same reminder twice across two restarts", async () => {
    // The claim is a conditional update, so the second process finds nothing
    // left to do rather than sending the message again.
    await make(at("2026-08-31T09:00:00Z"));

    const first = bootJobs();
    await first.start();
    await first.recover();

    const second = bootJobs();
    await second.start();
    const result = await second.recover();

    expect(result.delivered).toBe(0);
    expect(delivered).toHaveLength(1);
  });

  it("leaves a cancelled reminder alone", async () => {
    const reminder = await make(at("2026-08-31T09:00:00Z"));
    await repo.cancel(reminder.id);

    const jobs = bootJobs();
    await jobs.start();

    expect((await jobs.recover()).delivered).toBe(0);
    expect(delivered).toHaveLength(0);
  });

  it("does not deliver a reminder that is not due yet", async () => {
    await make(at("2026-08-31T18:00:00Z"));

    const jobs = bootJobs();
    await jobs.start();

    expect((await jobs.recover()).delivered).toBe(0);
    expect(delivered).toHaveLength(0);
  });

  it("reschedules a future reminder whose job was never created", async () => {
    // A crash between the insert and the send leaves exactly this: a row that
    // is due later with no job id. Nothing else would ever fire it.
    const orphan = await make(at("2026-08-31T18:00:00Z"));
    expect(orphan.jobId).toBeNull();

    const jobs = bootJobs();
    await jobs.start();
    const result = await jobs.recover();

    expect(result.rescheduled).toBe(1);
    expect((await repo.findById(orphan.id))?.jobId).not.toBeNull();
  });

  it("does not queue a second job for a reminder that already has one", async () => {
    // pg-boss keeps its jobs in Postgres, so they survive the restart too.
    const reminder = await make(at("2026-08-31T18:00:00Z"));
    await repo.attachJob(reminder.id, "job-already-there");

    const jobs = bootJobs();
    await jobs.start();

    expect((await jobs.recover()).rescheduled).toBe(0);
    expect((await repo.findById(reminder.id))?.jobId).toBe("job-already-there");
  });

  it("marks the reminder delivered before sending, so a failed send is not repeated forever", async () => {
    // The claim happens first on purpose. A send that throws makes pg-boss
    // retry, but the reminder is already claimed, so the retry is a no-op
    // rather than a loop that eventually floods the chat.
    const reminder = await make(at("2026-08-31T09:00:00Z"));

    const failing = bootJobs({ failDelivery: true });
    await failing.start();
    await expect(failing.recover()).rejects.toThrow(/telegram is down/);

    expect((await repo.findById(reminder.id))?.status).toBe("delivered");

    const retry = bootJobs();
    await retry.start();
    expect((await retry.recover()).delivered).toBe(0);
    expect(delivered).toHaveLength(0);
  });

  it("schedules through pg-boss and returns a job id", async () => {
    const jobs = bootJobs();
    await jobs.start();

    const jobId = await jobs.scheduler.schedule(crypto.randomUUID(), at("2026-09-01T10:00:00Z"));

    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(REMINDER_QUEUE).toBe("reminder-delivery");
  });
});
