import type { PgBoss } from "pg-boss";
import type { BriefingWriter } from "../agent/briefing.js";
import type { BriefingRepository } from "../db/repositories/briefing.js";
import type { BriefingScheduler, BriefingService } from "../domain/briefing/service.js";
import { formatCivilDate } from "../domain/datetime.js";
import type { Logger } from "../observability/logger.js";

/**
 * The morning briefing job.
 *
 * Two things make it different from reminder delivery, and both are deliberate.
 *
 *  - **It calls the model.** A reminder's text was written when the reminder
 *    was created, so delivery needs nobody; the briefing has to be composed
 *    from what today looks like. It is still one round trip with no tools, and
 *    it falls back to text written without a model if the provider is down.
 *  - **The claim can be given back.** Delivery claims today's date before
 *    sending, so a retry cannot produce a second briefing — but if the send
 *    fails the claim is released, so the retry can actually work. A reminder
 *    that lost its claim could fire repeatedly for real; a briefing's window is
 *    one UPDATE wide and it runs once a day, and losing a whole morning to a
 *    transient Telegram error is the worse outcome.
 *
 * The schedule itself is a pg-boss cron carrying an IANA timezone, so 07:30
 * stays 07:30 across daylight saving instead of drifting an hour twice a year.
 */

export const BRIEFING_QUEUE = "morning-briefing";

/** Retries cover a transient send failure; the claim is released for each one. */
const RETRY_LIMIT = 3;
const RETRY_DELAY_SECONDS = 60;

export interface BriefingDelivery {
  deliver(input: { chatId: string; text: string }): Promise<void>;
}

export interface BriefingJobOptions {
  /** Shared with every other job; started and stopped by its owner. */
  boss: PgBoss;
  repo: BriefingRepository;
  service: BriefingService;
  writer: BriefingWriter;
  delivery: BriefingDelivery;
  /** Where a briefing goes. Not derived from the allowlist: see decision E4. */
  chatId: string;
  timeZone: string;
  logger: Logger;
  now?: () => Date;
}

export interface BriefingJob {
  /** Handed to the domain service so a time change reschedules the cron. */
  scheduler: BriefingScheduler;
  /** Registers the queue and the worker, then installs the cron for `sendAt`. */
  start(sendAt: string): Promise<void>;
  /**
   * Composes and sends one briefing. Returns false when today's was already
   * delivered. `force` skips the once-a-day claim, for the smoke script.
   */
  run(options?: { force?: boolean }): Promise<boolean>;
}

/** `07:30` as the cron expression `30 7 * * *`. */
export function cronFor(sendAt: string): string {
  const [hour, minute] = sendAt.split(":");
  return `${Number(minute)} ${Number(hour)} * * *`;
}

export function createBriefingJob(opts: BriefingJobOptions): BriefingJob {
  const { boss, repo, service, writer, delivery, chatId, timeZone, logger } = opts;
  const clock = opts.now ?? (() => new Date());

  async function schedule(sendAt: string): Promise<void> {
    await boss.schedule(BRIEFING_QUEUE, cronFor(sendAt), null, {
      tz: timeZone,
      retryLimit: RETRY_LIMIT,
      retryDelay: RETRY_DELAY_SECONDS,
    });
    logger.info("briefing.scheduled", { sendAt, timeZone });
  }

  async function run({ force = false } = {}): Promise<boolean> {
    const now = clock();
    const today = formatCivilDate(now, timeZone);

    // Read the value, not the row: what gets put back on a failed send must be
    // a snapshot taken before the claim, not a field that the claim just moved.
    const previousDay = (await repo.get())?.lastSentOn ?? null;
    if (!force && previousDay === today) {
      logger.info("briefing.skipped", { date: today, reason: "already sent" });
      return false;
    }

    const data = await service.collect(now);
    const text = await writer.write(data);

    if (!force && !(await repo.claimDay(today))) {
      // Another attempt got there between the read above and here.
      logger.info("briefing.skipped", { date: today, reason: "claimed elsewhere" });
      return false;
    }

    try {
      await delivery.deliver({ chatId, text });
    } catch (err) {
      // Give the day back before letting pg-boss retry, or the retry would find
      // the day claimed and deliver nothing at all.
      if (!force) await repo.releaseDay(previousDay);
      throw err;
    }

    logger.info("briefing.delivered", {
      date: today,
      events: data.events.length,
      tasks: data.tasks.length,
      empty: data.empty,
      forced: force,
    });
    return true;
  }

  return {
    scheduler: {
      async reschedule(sendAt) {
        // pg-boss upserts on the queue name, so this replaces the cron rather
        // than adding a second one.
        await schedule(sendAt);
      },
    },

    async start(sendAt) {
      await boss.createQueue(BRIEFING_QUEUE);
      await boss.work(BRIEFING_QUEUE, async () => {
        await run();
      });
      await schedule(sendAt);
    },

    run,
  };
}
