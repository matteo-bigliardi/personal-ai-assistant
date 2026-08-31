import { PgBoss, type Job } from "pg-boss";
import type { RemindersRepository } from "../db/repositories/reminders.js";
import type { ReminderScheduler } from "../domain/reminders/service.js";
import type { Logger } from "../observability/logger.js";

/**
 * Reminder delivery.
 *
 * Three properties matter here, and each one is a decision rather than an
 * accident:
 *
 *  - **No LLM at delivery time.** The message was written when the reminder was
 *    created. If the model is unreachable, or slow, or expensive, the reminder
 *    still arrives on time.
 *  - **Idempotent.** pg-boss retries a failed job, so the same delivery can be
 *    attempted more than once. The status transition in the database, not a
 *    check in this file, is what makes the second attempt do nothing.
 *  - **Survives restarts.** The queue is a mechanism, not the record. Every
 *    reminder still waiting is a row, so a job lost with the process can simply
 *    be created again from the row at startup.
 */

export const REMINDER_QUEUE = "reminder-delivery";

/** A single user cannot plausibly have more outstanding reminders than this. */
const RECOVERY_LIMIT = 1000;

interface ReminderJob {
  reminderId: string;
}

export interface ReminderDelivery {
  /** Sends the reminder to its chat. Throwing makes pg-boss retry. */
  deliver(input: { chatId: string; reminderId: string; message: string }): Promise<void>;
}

export interface ReminderJobsOptions {
  connectionString: string;
  repo: RemindersRepository;
  delivery: ReminderDelivery;
  logger: Logger;
  now?: () => Date;
}

export interface ReminderJobs {
  scheduler: ReminderScheduler;
  /** Starts the queue and the worker. */
  start(): Promise<void>;
  /**
   * Reconciles the queue with the database: delivers what fell due while the
   * process was down and re-schedules everything still ahead.
   */
  recover(): Promise<{ delivered: number; rescheduled: number }>;
  stop(): Promise<void>;
}

export function createReminderJobs(opts: ReminderJobsOptions): ReminderJobs {
  const { repo, delivery, logger } = opts;
  const clock = opts.now ?? (() => new Date());

  // pg-boss keeps its own tables in its own schema, so it never collides with
  // the application schema or with Drizzle's migrations.
  const boss = new PgBoss({ connectionString: opts.connectionString, schema: "pgboss" });

  boss.on("error", (error: unknown) => logger.error("jobs.error", { error: String(error) }));

  /**
   * Delivers one reminder, or does nothing if it is no longer deliverable.
   *
   * The conditional status update is the whole idempotency mechanism: only the
   * attempt that finds the reminder still scheduled gets a row back, so a retry
   * after a failed send, or two workers racing, cannot deliver twice. The row
   * is claimed *before* the message goes out, which is the safe order — a crash
   * between the two loses a reminder rather than repeating it forever, and the
   * alternative risks an endless retry loop of real messages.
   */
  async function deliverOne(reminderId: string): Promise<boolean> {
    const reminder = await repo.findById(reminderId);
    if (!reminder) {
      logger.warn("reminder.missing", { reminderId });
      return false;
    }

    const claimed = await repo.markDelivered(reminderId, clock());
    if (!claimed) {
      // Cancelled, or already delivered by another attempt. Not an error.
      logger.info("reminder.skipped", { reminderId, status: reminder.status });
      return false;
    }

    await delivery.deliver({
      chatId: claimed.chatId,
      reminderId: claimed.id,
      message: claimed.message,
    });
    logger.info("reminder.delivered", {
      reminderId,
      lateBySeconds: Math.max(0, Math.round((clock().getTime() - claimed.dueAt.getTime()) / 1000)),
    });
    return true;
  }

  const scheduler: ReminderScheduler = {
    async schedule(reminderId, runAt) {
      return boss.send(
        REMINDER_QUEUE,
        { reminderId } satisfies ReminderJob,
        // Retries cover a transient Telegram failure. They are safe because
        // the claim above has already decided who delivers.
        { startAfter: runAt, retryLimit: 5, retryDelay: 30, retryBackoff: true },
      );
    },

    async cancel(jobId) {
      await boss.cancel(REMINDER_QUEUE, jobId);
    },
  };

  return {
    scheduler,

    async start() {
      await boss.start();
      await boss.createQueue(REMINDER_QUEUE);
      await boss.work<ReminderJob>(REMINDER_QUEUE, async (jobs: Job<ReminderJob>[]) => {
        for (const job of jobs) {
          await deliverOne(job.data.reminderId);
        }
      });
      logger.info("jobs.ready", { queue: REMINDER_QUEUE });
    },

    async recover() {
      const now = clock();
      let delivered = 0;
      let rescheduled = 0;

      // Anything already due is sent now, late and marked as such by the
      // delivery itself. Skipping it silently would be the worse failure: the
      // user trusts a reminder they never received.
      for (const reminder of await repo.findOverdue(now)) {
        if (await deliverOne(reminder.id)) delivered++;
      }

      // pg-boss keeps its jobs in Postgres, so a job scheduled before the
      // restart is still there: rescheduling everything would pile up
      // duplicates that fire and find nothing to do. The gap worth closing is
      // the reminder written to the database whose job was never created —
      // a crash between the insert and the send leaves exactly that, a row
      // with no job id.
      for (const reminder of await repo.list({
        statuses: ["pending", "snoozed"],
        limit: RECOVERY_LIMIT,
      })) {
        if (reminder.jobId !== null || reminder.dueAt.getTime() <= now.getTime()) continue;
        const jobId = await scheduler.schedule(reminder.id, reminder.dueAt);
        await repo.attachJob(reminder.id, jobId);
        rescheduled++;
      }

      if (delivered > 0 || rescheduled > 0) {
        logger.info("reminders.recovered", { delivered, rescheduled });
      }
      return { delivered, rescheduled };
    },

    async stop() {
      await boss.stop({ graceful: true });
    },
  };
}
