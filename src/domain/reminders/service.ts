import { reminderStatus, type Reminder } from "../../db/schema.js";
import type { RemindersRepository, ReminderStatus } from "../../db/repositories/reminders.js";
import { InvalidInputError, PreconditionFailedError } from "../errors.js";
import { normaliseRef, resolveOne } from "../reference.js";

/**
 * Reminder rules, independent of Telegram, of the model and of the job queue.
 *
 * The database is the authority on what has to be delivered; the queue is only
 * the mechanism that wakes something up at the right time. That ordering is
 * what makes recovery possible: a reminder whose job was lost is still a row
 * saying it is due, and can simply be scheduled again.
 */

export const MAX_MESSAGE_LENGTH = 500;

/** A minute is the finest granularity worth offering in a chat. */
export const MIN_DELAY_MINUTES = 1;

/** A year out is past the point where a reminder is a reminder. */
export const MAX_DELAY_MINUTES = 365 * 24 * 60;

export const REMINDER_STATUSES = reminderStatus.enumValues;

/**
 * The queue, as the domain needs it. Keeping pg-boss behind this means the
 * rules here can be tested without a running queue, and a different backend
 * later does not reach into the domain.
 */
export interface ReminderScheduler {
  /** Schedules a delivery, returning the job id if the backend supplies one. */
  schedule(reminderId: string, runAt: Date): Promise<string | null>;
  cancel(jobId: string): Promise<void>;
}

export interface CreateReminderArgs {
  chatId: string;
  message: string;
  /** Absolute instant, or `inMinutes`; exactly one of the two. */
  at?: Date | undefined;
  inMinutes?: number | undefined;
}

export interface RemindersService {
  create(args: CreateReminderArgs): Promise<Reminder>;
  list(args: {
    chatId: string;
    status?: ReminderStatus | undefined;
    limit: number;
  }): Promise<Reminder[]>;
  snooze(ref: string, minutes: number): Promise<Reminder>;
  cancel(ref: string): Promise<Reminder>;
}

function normaliseMessage(raw: string): string {
  const message = raw.trim().replace(/\s+/g, " ");
  if (message.length === 0) throw new InvalidInputError("A reminder needs something to say.");
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new InvalidInputError(`A reminder cannot exceed ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return message;
}

function assertDelay(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < MIN_DELAY_MINUTES || minutes > MAX_DELAY_MINUTES) {
    throw new InvalidInputError(
      `A delay must be a whole number of minutes between ${MIN_DELAY_MINUTES} and ${MAX_DELAY_MINUTES}.`,
    );
  }
}

export function createRemindersService(
  repo: RemindersRepository,
  scheduler: ReminderScheduler,
  clock: () => Date = () => new Date(),
): RemindersService {
  /**
   * Puts a reminder on the queue and records which job is now its own.
   *
   * The row is written first and the job second, so a crash in between leaves a
   * reminder that is due with no job — recoverable, because the sweep at
   * startup reschedules exactly that. The opposite order would leave a job
   * pointing at nothing.
   */
  async function scheduleFor(reminder: Reminder): Promise<void> {
    const jobId = await scheduler.schedule(reminder.id, reminder.dueAt);
    await repo.attachJob(reminder.id, jobId);
  }

  async function getByRef(rawRef: string): Promise<Reminder> {
    const ref = normaliseRef(rawRef, "reminder");
    return resolveOne(await repo.findByIdPrefix(ref, 2), ref, "reminder");
  }

  return {
    async create({ chatId, message, at, inMinutes }) {
      if ((at === undefined) === (inMinutes === undefined)) {
        throw new InvalidInputError(
          "Give either an absolute time or a delay in minutes, and exactly one of them.",
        );
      }

      const now = clock();
      let dueAt: Date;
      if (inMinutes !== undefined) {
        assertDelay(inMinutes);
        dueAt = new Date(now.getTime() + inMinutes * 60_000);
      } else {
        dueAt = at as Date;
      }

      // A reminder for a moment that has passed would fire immediately and look
      // like a bug. Say what happened instead.
      if (dueAt.getTime() <= now.getTime()) {
        throw new InvalidInputError("That moment has already passed.");
      }

      const created = await repo.create({
        chatId,
        message: normaliseMessage(message),
        dueAt,
      });
      await scheduleFor(created);
      return created;
    },

    async list({ chatId, status, limit }) {
      // Unlike tasks, no status is hidden by default: the list is short, and a
      // cancelled reminder disappearing without a trace is confusing when the
      // user is checking whether the cancellation took.
      return repo.list({ chatId, ...(status ? { statuses: [status] } : {}), limit });
    },

    async snooze(ref, minutes) {
      assertDelay(minutes);
      const reminder = await getByRef(ref);

      const dueAt = new Date(clock().getTime() + minutes * 60_000);
      const snoozed = await repo.snooze(reminder.id, dueAt);
      // Only a delivered reminder can be postponed: one that has not arrived
      // yet should be moved with a new time, not snoozed, and a cancelled one
      // is over.
      if (!snoozed) {
        throw new PreconditionFailedError(
          `That reminder is ${reminder.status}, so there is nothing to snooze.`,
        );
      }

      await scheduleFor(snoozed);
      return snoozed;
    },

    async cancel(ref) {
      const reminder = await getByRef(ref);
      // Read before the update clears it: which job to drop is a fact about the
      // reminder as it was, and reaching for it afterwards would depend on the
      // repository handing back a different object than the one just read.
      const { jobId, status } = reminder;

      const cancelled = await repo.cancel(reminder.id);
      if (!cancelled) {
        throw new PreconditionFailedError(
          `That reminder is already ${status}, so it cannot be cancelled.`,
        );
      }

      // The row is authoritative: even if dropping the job fails, the delivery
      // will find a cancelled reminder and do nothing.
      if (jobId) await scheduler.cancel(jobId);
      return cancelled;
    },
  };
}
