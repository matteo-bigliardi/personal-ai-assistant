import { describe, expect, it, vi } from "vitest";
import {
  createRemindersService,
  type ReminderScheduler,
} from "../../src/domain/reminders/service.js";
import type {
  CreateReminderInput,
  RemindersRepository,
} from "../../src/db/repositories/reminders.js";
import type { Reminder } from "../../src/db/schema.js";
import { shortRef } from "../../src/domain/reference.js";
import {
  InvalidInputError,
  NotFoundError,
  PreconditionFailedError,
} from "../../src/domain/errors.js";

/**
 * The transitions are guarded by conditional updates in the database and proved
 * by the integration tests. Here we exercise what the service owns: which of
 * `at` and `in_minutes` is allowed, that a reminder cannot be scheduled into
 * the past, and that scheduling and cancelling reach the queue.
 */

const NOW = new Date("2026-08-31T10:00:00Z");
const CHAT = "chat-1";

function fakeRepo(seed: Partial<Reminder>[] = []): RemindersRepository & { rows: Reminder[] } {
  const rows: Reminder[] = seed.map((r, i) => ({
    id: r.id ?? `aaaaaaa${i}-0000-4000-8000-000000000000`,
    chatId: r.chatId ?? CHAT,
    message: r.message ?? `reminder-${i}`,
    dueAt: r.dueAt ?? new Date("2026-08-31T12:00:00Z"),
    status: r.status ?? "pending",
    jobId: r.jobId ?? null,
    snoozeCount: r.snoozeCount ?? 0,
    createdAt: NOW,
    updatedAt: NOW,
    deliveredAt: r.deliveredAt ?? null,
  }));

  const scheduled = ["pending", "snoozed"];

  return {
    rows,
    async create(input: CreateReminderInput) {
      const row: Reminder = {
        id: `bbbbbbb${rows.length}-0000-4000-8000-000000000000`,
        chatId: input.chatId,
        message: input.message,
        dueAt: input.dueAt,
        status: "pending",
        jobId: null,
        snoozeCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
        deliveredAt: null,
      };
      rows.push(row);
      return row;
    },
    async findById(id) {
      return rows.find((r) => r.id === id);
    },
    async findByIdPrefix(prefix, limit) {
      return rows.filter((r) => r.id.startsWith(prefix)).slice(0, limit);
    },
    async list({ chatId, statuses, limit }) {
      return rows
        .filter((r) => !chatId || r.chatId === chatId)
        .filter((r) => !statuses?.length || statuses.includes(r.status))
        .slice(0, limit);
    },
    async attachJob(id, jobId) {
      const row = rows.find((r) => r.id === id);
      if (row) row.jobId = jobId;
    },
    async markDelivered(id, deliveredAt) {
      const row = rows.find((r) => r.id === id && scheduled.includes(r.status));
      if (!row) return undefined;
      row.status = "delivered";
      row.deliveredAt = deliveredAt;
      row.jobId = null;
      return row;
    },
    async snooze(id, dueAt) {
      const row = rows.find((r) => r.id === id && r.status === "delivered");
      if (!row) return undefined;
      row.status = "snoozed";
      row.dueAt = dueAt;
      row.snoozeCount += 1;
      return row;
    },
    async cancel(id) {
      const row = rows.find((r) => r.id === id && scheduled.includes(r.status));
      if (!row) return undefined;
      row.status = "cancelled";
      row.jobId = null;
      return row;
    },
    async findOverdue(asOf) {
      return rows.filter((r) => scheduled.includes(r.status) && r.dueAt <= asOf);
    },
  };
}

function fakeScheduler(): ReminderScheduler & { scheduled: { id: string; runAt: Date }[] } {
  const scheduled: { id: string; runAt: Date }[] = [];
  return {
    scheduled,
    async schedule(reminderId, runAt) {
      scheduled.push({ id: reminderId, runAt });
      return `job-${scheduled.length}`;
    },
    cancel: vi.fn(async () => {}),
  };
}

const service = (
  repo: RemindersRepository,
  scheduler: ReminderScheduler = fakeScheduler(),
  now: Date = NOW,
) => createRemindersService(repo, scheduler, () => now);

describe("reminders service", () => {
  describe("create", () => {
    it("schedules a reminder from a delay in minutes", async () => {
      const repo = fakeRepo();
      const scheduler = fakeScheduler();

      const reminder = await service(repo, scheduler).create({
        chatId: CHAT,
        message: "check the build",
        inMinutes: 45,
      });

      expect(reminder.dueAt).toEqual(new Date("2026-08-31T10:45:00Z"));
      expect(scheduler.scheduled).toEqual([{ id: reminder.id, runAt: reminder.dueAt }]);
    });

    it("records the job so it can be cancelled later", async () => {
      const repo = fakeRepo();
      const reminder = await service(repo).create({
        chatId: CHAT,
        message: "check the build",
        inMinutes: 45,
      });

      expect(repo.rows.find((r) => r.id === reminder.id)?.jobId).toBe("job-1");
    });

    it("schedules a reminder from an absolute instant", async () => {
      const at = new Date("2026-08-31T15:00:00Z");
      const reminder = await service(fakeRepo()).create({ chatId: CHAT, message: "call", at });

      expect(reminder.dueAt).toEqual(at);
    });

    it("refuses both an instant and a delay at once", async () => {
      await expect(
        service(fakeRepo()).create({
          chatId: CHAT,
          message: "call",
          at: new Date("2026-08-31T15:00:00Z"),
          inMinutes: 45,
        }),
      ).rejects.toThrow(/exactly one/);
    });

    it("refuses neither of them", async () => {
      await expect(service(fakeRepo()).create({ chatId: CHAT, message: "call" })).rejects.toThrow(
        InvalidInputError,
      );
    });

    it("refuses a moment that has already passed", async () => {
      // Otherwise it fires instantly and reads as a bug rather than as input.
      await expect(
        service(fakeRepo()).create({
          chatId: CHAT,
          message: "call",
          at: new Date("2026-08-31T09:00:00Z"),
        }),
      ).rejects.toThrow(/already passed/);
    });

    it("refuses a fractional or absurd delay", async () => {
      const repo = fakeRepo();
      await expect(
        service(repo).create({ chatId: CHAT, message: "call", inMinutes: 1.5 }),
      ).rejects.toThrow(InvalidInputError);
      await expect(
        service(repo).create({ chatId: CHAT, message: "call", inMinutes: 0 }),
      ).rejects.toThrow(InvalidInputError);
    });

    it("refuses an empty message", async () => {
      await expect(
        service(fakeRepo()).create({ chatId: CHAT, message: "   ", inMinutes: 5 }),
      ).rejects.toThrow(/something to say/);
    });
  });

  describe("snooze", () => {
    it("postpones a delivered reminder and schedules it again", async () => {
      const repo = fakeRepo([{ status: "delivered", deliveredAt: NOW }]);
      const scheduler = fakeScheduler();

      const snoozed = await service(repo, scheduler).snooze(shortRef(repo.rows[0]!), 10);

      expect(snoozed.status).toBe("snoozed");
      expect(snoozed.dueAt).toEqual(new Date("2026-08-31T10:10:00Z"));
      expect(snoozed.snoozeCount).toBe(1);
      expect(scheduler.scheduled).toHaveLength(1);
    });

    it("refuses to snooze a reminder that has not fired yet", async () => {
      const repo = fakeRepo([{ status: "pending" }]);

      await expect(service(repo).snooze(shortRef(repo.rows[0]!), 10)).rejects.toThrow(
        PreconditionFailedError,
      );
    });

    it("refuses to snooze a cancelled reminder", async () => {
      const repo = fakeRepo([{ status: "cancelled" }]);

      await expect(service(repo).snooze(shortRef(repo.rows[0]!), 10)).rejects.toThrow(/cancelled/);
    });

    it("reports an unknown id", async () => {
      await expect(service(fakeRepo()).snooze("deadbeef", 10)).rejects.toThrow(NotFoundError);
    });
  });

  describe("cancel", () => {
    it("cancels a pending reminder and drops its job", async () => {
      const repo = fakeRepo([{ status: "pending", jobId: "job-9" }]);
      const scheduler = fakeScheduler();

      const cancelled = await service(repo, scheduler).cancel(shortRef(repo.rows[0]!));

      expect(cancelled.status).toBe("cancelled");
      expect(scheduler.cancel).toHaveBeenCalledWith("job-9");
    });

    it("cancels a snoozed reminder too", async () => {
      const repo = fakeRepo([{ status: "snoozed", deliveredAt: NOW }]);

      expect((await service(repo).cancel(shortRef(repo.rows[0]!))).status).toBe("cancelled");
    });

    it("refuses to cancel one that has already been delivered", async () => {
      const repo = fakeRepo([{ status: "delivered", deliveredAt: NOW }]);

      await expect(service(repo).cancel(shortRef(repo.rows[0]!))).rejects.toThrow(
        PreconditionFailedError,
      );
    });

    it("does not call the queue when there is no job to drop", async () => {
      const repo = fakeRepo([{ status: "pending", jobId: null }]);
      const scheduler = fakeScheduler();

      await service(repo, scheduler).cancel(shortRef(repo.rows[0]!));

      expect(scheduler.cancel).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("returns every status, including cancelled ones", async () => {
      // Unlike tasks: someone checking whether a cancellation took needs to see
      // that it did, not an empty list.
      const repo = fakeRepo([{ status: "pending" }, { status: "cancelled" }]);

      const listed = await service(repo).list({ chatId: CHAT, limit: 10 });

      expect(listed.map((r) => r.status)).toEqual(["pending", "cancelled"]);
    });

    it("narrows to one status when asked", async () => {
      const repo = fakeRepo([{ status: "pending" }, { status: "cancelled" }]);

      const listed = await service(repo).list({ chatId: CHAT, status: "cancelled", limit: 10 });

      expect(listed).toHaveLength(1);
    });

    it("never returns another chat's reminders", async () => {
      const repo = fakeRepo([{ chatId: CHAT }, { chatId: "somebody-else" }]);

      const listed = await service(repo).list({ chatId: CHAT, limit: 10 });

      expect(listed).toHaveLength(1);
    });
  });
});
