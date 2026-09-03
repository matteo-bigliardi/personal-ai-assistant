import { describe, expect, it, vi } from "vitest";
import { createCalendarService } from "../../src/domain/calendar/service.js";
import type { CalendarEvent, CalendarPort } from "../../src/domain/calendar/port.js";
import { InvalidInputError, NotFoundError } from "../../src/domain/errors.js";

/**
 * Google is authoritative for appointments, so there is nothing of ours to
 * assert about storage. What the service owns is the policy around the calls:
 * range limits, what counts as busy, and reading an event before deleting it
 * so the deletion can be reported.
 */

const at = (iso: string) => new Date(iso);

function event(overrides: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    summary: "Meeting",
    start: at("2026-09-02T09:00:00Z"),
    end: at("2026-09-02T10:00:00Z"),
    allDay: false,
    ...overrides,
  };
}

function fakeCalendar(events: CalendarEvent[] = []): CalendarPort & {
  deleted: string[];
  patched: { id: string; patch: unknown }[];
} {
  const deleted: string[] = [];
  const patched: { id: string; patch: unknown }[] = [];

  return {
    deleted,
    patched,
    async list({ from, to, limit }) {
      return events.filter((e) => e.start < to && e.end > from).slice(0, limit);
    },
    async get(id) {
      const found = events.find((e) => e.id === id);
      if (!found) throw new NotFoundError(`No calendar event with id "${id}".`);
      return found;
    },
    async create(input) {
      return event({ id: "created", ...input, allDay: false });
    },
    async update(id, patch) {
      patched.push({ id, patch });
      const found = events.find((e) => e.id === id);
      if (!found) throw new NotFoundError(`No calendar event with id "${id}".`);
      return { ...found, ...patch };
    },
    async delete(id) {
      deleted.push(id);
    },
  };
}

const DAY = { from: at("2026-09-02T07:00:00Z"), to: at("2026-09-02T17:00:00Z") };

describe("calendar service", () => {
  describe("list", () => {
    it("returns events overlapping the range", async () => {
      const service = createCalendarService(fakeCalendar([event({ id: "a" })]));
      expect(await service.list({ ...DAY, limit: 10 })).toHaveLength(1);
    });

    it("refuses a backwards range", async () => {
      const service = createCalendarService(fakeCalendar());
      await expect(service.list({ from: DAY.to, to: DAY.from, limit: 10 })).rejects.toThrow(
        /ends before it starts/,
      );
    });

    it("refuses a range wide enough to drag in the whole calendar", async () => {
      const service = createCalendarService(fakeCalendar());
      await expect(
        service.list({
          from: at("2026-01-01T00:00:00Z"),
          to: at("2026-12-31T00:00:00Z"),
          limit: 10,
        }),
      ).rejects.toThrow(/more than 62 days/);
    });
  });

  describe("create", () => {
    it("normalises the title", async () => {
      const service = createCalendarService(fakeCalendar());
      const created = await service.create({
        summary: "  Demo   review ",
        start: at("2026-09-02T09:00:00Z"),
        end: at("2026-09-02T10:00:00Z"),
      });
      expect(created.summary).toBe("Demo review");
    });

    it("refuses an event that ends when it starts", async () => {
      const service = createCalendarService(fakeCalendar());
      const instant = at("2026-09-02T09:00:00Z");
      await expect(
        service.create({ summary: "Demo", start: instant, end: instant }),
      ).rejects.toThrow(/must end after it starts/);
    });

    it("refuses an empty title", async () => {
      const service = createCalendarService(fakeCalendar());
      await expect(
        service.create({
          summary: "   ",
          start: at("2026-09-02T09:00:00Z"),
          end: at("2026-09-02T10:00:00Z"),
        }),
      ).rejects.toThrow(/needs a title/);
    });
  });

  describe("update", () => {
    it("passes only the fields given", async () => {
      const calendar = fakeCalendar([event({ id: "a" })]);
      await createCalendarService(calendar).update("a", { summary: "Moved" });

      expect(calendar.patched).toEqual([{ id: "a", patch: { summary: "Moved" } }]);
    });

    it("refuses an update that changes nothing", async () => {
      const service = createCalendarService(fakeCalendar([event({ id: "a" })]));
      await expect(service.update("a", {})).rejects.toThrow(/Nothing to update/);
    });

    it("reports a missing event", async () => {
      const service = createCalendarService(fakeCalendar());
      await expect(service.update("ghost", { summary: "x" })).rejects.toThrow(NotFoundError);
    });
  });

  describe("delete", () => {
    it("reads the event before deleting so it can be reported", async () => {
      // After the delete there is nothing left to describe, and "deleted
      // something" is a poor thing to tell a user about their calendar.
      const calendar = fakeCalendar([event({ id: "a", summary: "Dentist" })]);

      const gone = await createCalendarService(calendar).delete("a");

      expect(gone.summary).toBe("Dentist");
      expect(calendar.deleted).toEqual(["a"]);
    });

    it("does not delete when the event does not exist", async () => {
      const calendar = fakeCalendar();
      const service = createCalendarService(calendar);

      await expect(service.delete("ghost")).rejects.toThrow(NotFoundError);
      expect(calendar.deleted).toEqual([]);
    });
  });

  describe("findFree", () => {
    it("treats timed events as busy", async () => {
      const calendar = fakeCalendar([
        event({ id: "a", start: at("2026-09-02T09:00:00Z"), end: at("2026-09-02T11:00:00Z") }),
      ]);

      const { slots } = await createCalendarService(calendar).findFree({
        ...DAY,
        minimumMinutes: 60,
        limit: 10,
      });

      expect(slots.map((s) => s.start.toISOString())).toEqual([
        "2026-09-02T07:00:00.000Z",
        "2026-09-02T11:00:00.000Z",
      ]);
    });

    it("does not let an all-day event block the day, but reports it", async () => {
      // A birthday should not empty the day; a holiday should be mentioned.
      // The two are indistinguishable, so the slot stays and the event is named.
      const calendar = fakeCalendar([
        event({
          id: "bday",
          summary: "Marco's birthday",
          allDay: true,
          start: at("2026-09-02T00:00:00Z"),
          end: at("2026-09-03T00:00:00Z"),
        }),
      ]);

      const { slots, allDay } = await createCalendarService(calendar).findFree({
        ...DAY,
        minimumMinutes: 60,
        limit: 10,
      });

      expect(slots).toHaveLength(1);
      expect(allDay.map((e) => e.summary)).toEqual(["Marco's birthday"]);
    });

    it("refuses a range wider than the cap", async () => {
      const service = createCalendarService(fakeCalendar());
      await expect(
        service.findFree({
          from: at("2026-01-01T00:00:00Z"),
          to: at("2026-06-01T00:00:00Z"),
          minimumMinutes: 60,
          limit: 5,
        }),
      ).rejects.toThrow(InvalidInputError);
    });

    it("asks the calendar for a wide page, not just the slot limit", async () => {
      // Returning three slots still requires seeing every meeting in the
      // window: paging by the slot limit would invent free time.
      const list = vi.fn(async () => []);
      const calendar = { ...fakeCalendar(), list };

      await createCalendarService(calendar).findFree({ ...DAY, minimumMinutes: 60, limit: 3 });

      expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 250 }));
    });
  });
});
