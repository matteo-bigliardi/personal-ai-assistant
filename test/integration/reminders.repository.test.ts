import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createRemindersRepository,
  type RemindersRepository,
} from "../../src/db/repositories/reminders.js";
import { setupTestDb } from "./helpers/db.js";

/**
 * These run against a real Postgres because the behaviour under test lives in
 * the database: the conditional status updates are what make delivery
 * idempotent under pg-boss retries, and no fake can prove that two concurrent
 * claims cannot both succeed.
 */
const testDb = await setupTestDb();
const describeDb = testDb ? describe : describe.skip;

if (!testDb) {
  console.warn("[integration] no Postgres reachable — skipping repository tests");
}

/** Drizzle wraps driver errors, so the constraint name sits on a `cause`. */
function constraintOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === "string") return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const at = (iso: string) => new Date(iso);
const CHAT = "chat-1";

describeDb("reminders repository", () => {
  let repo: RemindersRepository;

  beforeEach(async () => {
    await testDb?.truncate();
    if (testDb) repo = createRemindersRepository(testDb.db);
  });

  afterAll(async () => {
    await testDb?.close();
  });

  const make = (overrides: { chatId?: string; dueAt?: Date; message?: string } = {}) =>
    repo.create({
      chatId: overrides.chatId ?? CHAT,
      message: overrides.message ?? "check the build",
      dueAt: overrides.dueAt ?? at("2026-08-31T12:00:00Z"),
    });

  it("creates a pending reminder with no delivery time", async () => {
    const reminder = await make();

    expect(reminder.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(reminder.status).toBe("pending");
    expect(reminder.deliveredAt).toBeNull();
    expect(reminder.jobId).toBeNull();
    expect(reminder.snoozeCount).toBe(0);
  });

  it("delivers exactly once, however many times the job is retried", async () => {
    // This is the whole idempotency mechanism. pg-boss retries a failed job,
    // and two workers can race on the same one: only the update that finds the
    // reminder still scheduled comes back with a row.
    const reminder = await make();

    const first = await repo.markDelivered(reminder.id, at("2026-08-31T12:00:01Z"));
    const second = await repo.markDelivered(reminder.id, at("2026-08-31T12:05:00Z"));

    expect(first?.status).toBe("delivered");
    expect(second).toBeUndefined();
    // The second attempt must not move the delivery time either.
    expect((await repo.findById(reminder.id))?.deliveredAt).toEqual(at("2026-08-31T12:00:01Z"));
  });

  it("does not deliver a cancelled reminder", async () => {
    const reminder = await make();
    await repo.cancel(reminder.id);

    expect(await repo.markDelivered(reminder.id, at("2026-08-31T12:00:01Z"))).toBeUndefined();
    expect((await repo.findById(reminder.id))?.status).toBe("cancelled");
  });

  it("clears the job id once delivered, so nothing tries to cancel it later", async () => {
    const reminder = await make();
    await repo.attachJob(reminder.id, "job-1");

    const delivered = await repo.markDelivered(reminder.id, at("2026-08-31T12:00:01Z"));

    expect(delivered?.jobId).toBeNull();
  });

  it("snoozes only a delivered reminder, and counts the snoozes", async () => {
    const reminder = await make();

    // Not yet delivered: nothing to postpone.
    expect(await repo.snooze(reminder.id, at("2026-08-31T13:00:00Z"))).toBeUndefined();

    await repo.markDelivered(reminder.id, at("2026-08-31T12:00:01Z"));
    const snoozed = await repo.snooze(reminder.id, at("2026-08-31T13:00:00Z"));

    expect(snoozed?.status).toBe("snoozed");
    expect(snoozed?.dueAt).toEqual(at("2026-08-31T13:00:00Z"));
    expect(snoozed?.snoozeCount).toBe(1);
    // A snoozed reminder keeps the record that it was already delivered once.
    expect(snoozed?.deliveredAt).toEqual(at("2026-08-31T12:00:01Z"));
  });

  it("delivers a snoozed reminder again", async () => {
    const reminder = await make();
    await repo.markDelivered(reminder.id, at("2026-08-31T12:00:01Z"));
    await repo.snooze(reminder.id, at("2026-08-31T13:00:00Z"));

    const redelivered = await repo.markDelivered(reminder.id, at("2026-08-31T13:00:01Z"));

    expect(redelivered?.status).toBe("delivered");
    expect(redelivered?.snoozeCount).toBe(1);
  });

  it("cancels only while still scheduled", async () => {
    const pending = await make();
    expect((await repo.cancel(pending.id))?.status).toBe("cancelled");

    const delivered = await make();
    await repo.markDelivered(delivered.id, at("2026-08-31T12:00:01Z"));
    expect(await repo.cancel(delivered.id)).toBeUndefined();
  });

  it("finds what fell due while the process was down", async () => {
    const overdue = await make({ dueAt: at("2026-08-31T09:00:00Z") });
    const snoozedOverdue = await make({ dueAt: at("2026-08-31T08:00:00Z") });
    await repo.markDelivered(snoozedOverdue.id, at("2026-08-31T08:00:01Z"));
    await repo.snooze(snoozedOverdue.id, at("2026-08-31T09:30:00Z"));
    await make({ dueAt: at("2026-08-31T18:00:00Z") });
    const cancelled = await make({ dueAt: at("2026-08-31T07:00:00Z") });
    await repo.cancel(cancelled.id);

    const due = await repo.findOverdue(at("2026-08-31T10:00:00Z"));

    // Both a pending and a snoozed reminder can be overdue; a cancelled one
    // never is, and neither is one still in the future.
    expect(due.map((r) => r.id).sort()).toEqual([overdue.id, snoozedOverdue.id].sort());
  });

  it("keeps each chat's reminders to itself", async () => {
    await make({ chatId: "chat-1" });
    await make({ chatId: "chat-2" });

    expect(await repo.list({ chatId: "chat-1", limit: 10 })).toHaveLength(1);
  });

  it("refuses a pending reminder that carries a delivery time", async () => {
    // The CHECK is what makes an inconsistent reminder impossible rather than
    // merely unlikely.
    const reminder = await make();

    let constraint: string | undefined;
    try {
      await testDb?.pool.query("UPDATE reminders SET delivered_at = now() WHERE id = $1", [
        reminder.id,
      ]);
    } catch (err) {
      constraint = constraintOf(err);
    }
    expect(constraint).toBe("reminders_pending_not_delivered");
  });

  it("refuses a delivered reminder with no delivery time", async () => {
    const reminder = await make();

    let constraint: string | undefined;
    try {
      await testDb?.pool.query("UPDATE reminders SET status = 'delivered' WHERE id = $1", [
        reminder.id,
      ]);
    } catch (err) {
      constraint = constraintOf(err);
    }
    expect(constraint).toBe("reminders_delivered_has_timestamp");
  });

  it("stores instants in UTC and reads them back unchanged", async () => {
    const dueAt = at("2026-08-31T12:00:00.000Z");
    const reminder = await make({ dueAt });

    expect((await repo.findById(reminder.id))?.dueAt.toISOString()).toBe(dueAt.toISOString());
  });
});
