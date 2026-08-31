import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { reminders, type Reminder } from "../schema.js";

/**
 * Persistence for reminders. This layer owns SQL and nothing else: no policy,
 * no formatting, no knowledge of the chat, of pg-boss or of the model.
 */

export type ReminderStatus = Reminder["status"];

/** Statuses from which a reminder is still waiting to fire. */
export const SCHEDULED_STATUSES: ReminderStatus[] = ["pending", "snoozed"];

export interface CreateReminderInput {
  chatId: string;
  message: string;
  dueAt: Date;
}

export interface ListRemindersInput {
  chatId?: string | undefined;
  statuses?: ReminderStatus[] | undefined;
  limit: number;
}

export interface RemindersRepository {
  create(input: CreateReminderInput): Promise<Reminder>;
  findById(id: string): Promise<Reminder | undefined>;
  findByIdPrefix(prefix: string, limit: number): Promise<Reminder[]>;
  list(input: ListRemindersInput): Promise<Reminder[]>;
  /** Records which pg-boss job is currently scheduled for this reminder. */
  attachJob(id: string, jobId: string | null): Promise<void>;
  /**
   * Marks a reminder delivered, but only from a state that is still waiting to
   * fire. Returns undefined when the transition did not apply, which is how a
   * retried job avoids delivering twice.
   */
  markDelivered(id: string, deliveredAt: Date): Promise<Reminder | undefined>;
  /** Postpones a delivered reminder. Applies only to `delivered`. */
  snooze(id: string, dueAt: Date): Promise<Reminder | undefined>;
  /** Calls a reminder off. Applies only while it is still scheduled. */
  cancel(id: string): Promise<Reminder | undefined>;
  /** Scheduled reminders already due at `asOf`, oldest first. */
  findOverdue(asOf: Date): Promise<Reminder[]>;
}

export function createRemindersRepository(db: Database): RemindersRepository {
  return {
    async create({ chatId, message, dueAt }) {
      // The application clock is the single authority for domain timestamps.
      const at = new Date();
      const [row] = await db
        .insert(reminders)
        .values({ chatId, message, dueAt, createdAt: at, updatedAt: at })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return row;
    },

    async findById(id) {
      const [row] = await db.select().from(reminders).where(eq(reminders.id, id)).limit(1);
      return row;
    },

    async findByIdPrefix(prefix, limit) {
      // The caller guarantees the prefix is hexadecimal-with-dashes, so it
      // carries no LIKE wildcards of its own.
      return db
        .select()
        .from(reminders)
        .where(sql`${reminders.id}::text LIKE ${`${prefix}%`}`)
        .orderBy(asc(reminders.dueAt))
        .limit(limit);
    },

    async list({ chatId, statuses, limit }) {
      const filters = [
        chatId ? eq(reminders.chatId, chatId) : undefined,
        statuses?.length ? inArray(reminders.status, statuses) : undefined,
      ].filter((f) => f !== undefined);

      return db
        .select()
        .from(reminders)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(asc(reminders.dueAt))
        .limit(limit);
    },

    async attachJob(id, jobId) {
      await db.update(reminders).set({ jobId, updatedAt: new Date() }).where(eq(reminders.id, id));
    },

    async markDelivered(id, deliveredAt) {
      // The status guard in the WHERE clause is the whole idempotency
      // mechanism: pg-boss retries a failed job, and two workers may race on
      // the same one. Only the update that finds the reminder still scheduled
      // returns a row, so exactly one delivery can proceed. Reading the status
      // first and updating after would leave a window between the two.
      const [row] = await db
        .update(reminders)
        .set({ status: "delivered", deliveredAt, jobId: null, updatedAt: new Date() })
        .where(and(eq(reminders.id, id), inArray(reminders.status, SCHEDULED_STATUSES)))
        .returning();
      return row;
    },

    async snooze(id, dueAt) {
      const [row] = await db
        .update(reminders)
        .set({
          status: "snoozed",
          dueAt,
          snoozeCount: sql`${reminders.snoozeCount} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(reminders.id, id), eq(reminders.status, "delivered")))
        .returning();
      return row;
    },

    async cancel(id) {
      const [row] = await db
        .update(reminders)
        .set({ status: "cancelled", jobId: null, updatedAt: new Date() })
        .where(and(eq(reminders.id, id), inArray(reminders.status, SCHEDULED_STATUSES)))
        .returning();
      return row;
    },

    async findOverdue(asOf) {
      return db
        .select()
        .from(reminders)
        .where(and(inArray(reminders.status, SCHEDULED_STATUSES), lte(reminders.dueAt, asOf)))
        .orderBy(asc(reminders.dueAt));
    },
  };
}
