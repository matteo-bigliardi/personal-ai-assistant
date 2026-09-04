import { describe, expect, it } from "vitest";
import type { BriefingRepository } from "../../src/db/repositories/briefing.js";
import type { TaskWithProject } from "../../src/db/repositories/tasks.js";
import type { BriefingSettings } from "../../src/db/schema.js";
import {
  createBriefingService,
  parseSendAt,
  renderBriefing,
  type BriefingData,
} from "../../src/domain/briefing/service.js";
import type { CalendarEvent } from "../../src/domain/calendar/port.js";
import type { CalendarService } from "../../src/domain/calendar/service.js";
import type { TasksService } from "../../src/domain/tasks/service.js";
import { createTestLogger } from "../helpers/logger.js";

const TZ = "Europe/Rome";
/** A Wednesday, 06:00 local. */
const NOW = new Date("2026-09-09T04:00:00Z");

function fakeRepo(overrides: Partial<BriefingSettings> = {}) {
  const row: BriefingSettings = {
    id: true,
    sendAt: "07:30",
    lastSentOn: null,
    updatedAt: NOW,
    ...overrides,
  };
  const repo: BriefingRepository = {
    async ensure() {
      return row;
    },
    async get() {
      return row;
    },
    async setSendAt(sendAt) {
      row.sendAt = sendAt;
      return row;
    },
    async claimDay(localDate) {
      if (row.lastSentOn === localDate) return false;
      row.lastSentOn = localDate;
      return true;
    },
    async releaseDay(previous) {
      row.lastSentOn = previous;
    },
  };
  return { repo, row };
}

function fakeTasks(rows: Partial<TaskWithProject>[]): TasksService {
  const tasks = rows.map(
    (row) =>
      ({
        id: "00000000-0000-0000-0000-000000000000",
        projectId: null,
        title: "a task",
        description: null,
        status: "open",
        priority: null,
        dueAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        projectName: null,
        ...row,
      }) as TaskWithProject,
  );
  return {
    async list() {
      return tasks;
    },
  } as unknown as TasksService;
}

function fakeCalendar(events: Partial<CalendarEvent>[] | Error): CalendarService {
  return {
    async list() {
      if (events instanceof Error) throw events;
      return events.map(
        (event) =>
          ({
            id: "e1",
            summary: "an event",
            start: NOW,
            end: NOW,
            allDay: false,
            ...event,
          }) as CalendarEvent,
      );
    },
  } as unknown as CalendarService;
}

function serviceWith(opts: {
  repo?: BriefingRepository;
  tasks?: TasksService;
  calendar?: CalendarService | undefined;
  scheduled?: string[];
}) {
  const scheduled = opts.scheduled ?? [];
  return createBriefingService({
    repo: opts.repo ?? fakeRepo().repo,
    tasks: opts.tasks ?? fakeTasks([]),
    calendar: opts.calendar,
    scheduler: {
      async reschedule(sendAt) {
        scheduled.push(sendAt);
      },
    },
    logger: createTestLogger(),
    timeZone: TZ,
  });
}

describe("parseSendAt", () => {
  it("accepts a 24-hour time and pads a single-digit hour", () => {
    expect(parseSendAt("07:30")).toBe("07:30");
    expect(parseSendAt("7:30")).toBe("07:30");
    expect(parseSendAt(" 23:59 ")).toBe("23:59");
  });

  it("refuses anything that is not a time of day", () => {
    for (const bad of ["24:00", "07:60", "7.30", "morning", "0730", 730, null]) {
      expect(() => parseSendAt(bad)).toThrow(/time/i);
    }
  });
});

describe("briefing collection", () => {
  it("reports today's events and the tasks due or overdue", async () => {
    const service = serviceWith({
      calendar: fakeCalendar([
        {
          summary: "revisione",
          start: new Date("2026-09-09T06:00:00Z"),
          end: new Date("2026-09-09T07:00:00Z"),
        },
        { summary: "compleanno", allDay: true },
      ]),
      tasks: fakeTasks([
        { title: "prepare demo", dueAt: new Date("2026-09-09T21:59:59Z"), projectName: "Atlas" },
        { title: "send invoice", dueAt: new Date("2026-09-05T21:59:59Z") },
      ]),
    });

    const data = await service.collect(NOW);

    expect(data.date).toBe("2026-09-09");
    expect(data.events).toEqual([
      { summary: "revisione", allDay: false, start: "08:00", end: "09:00" },
      { summary: "compleanno", allDay: true },
    ]);
    expect(data.tasks).toEqual([
      { title: "prepare demo", project: "Atlas", dueOn: "2026-09-09", overdue: false },
      { title: "send invoice", project: null, dueOn: "2026-09-05", overdue: true },
    ]);
    expect(data.empty).toBe(false);
    expect(data.calendarUnavailable).toBe(false);
  });

  it("marks an empty day as empty rather than as nothing to send", async () => {
    const data = await serviceWith({ calendar: fakeCalendar([]) }).collect(NOW);

    expect(data.empty).toBe(true);
    expect(data.calendarUnavailable).toBe(false);
  });

  it("survives a calendar that cannot be read, and says so", async () => {
    const data = await serviceWith({
      calendar: fakeCalendar(new Error("google is down")),
      tasks: fakeTasks([{ title: "prepare demo", dueAt: new Date("2026-09-09T21:59:59Z") }]),
    }).collect(NOW);

    // "No events" and "we could not look" must not be the same answer.
    expect(data.calendarUnavailable).toBe(true);
    expect(data.events).toEqual([]);
    expect(data.tasks).toHaveLength(1);
  });

  it("treats a missing calendar integration as unavailable, not as a free day", async () => {
    const data = await serviceWith({ calendar: undefined }).collect(NOW);

    expect(data.calendarUnavailable).toBe(true);
  });
});

describe("briefing schedule", () => {
  it("stores the new time and reschedules the job", async () => {
    const { repo, row } = fakeRepo();
    const scheduled: string[] = [];

    const applied = await serviceWith({ repo, scheduled }).setSendAt("8:05");

    expect(applied).toBe("08:05");
    expect(row.sendAt).toBe("08:05");
    expect(scheduled).toEqual(["08:05"]);
  });

  it("rejects a bad time before touching the schedule", async () => {
    const { repo, row } = fakeRepo();
    const scheduled: string[] = [];

    await expect(serviceWith({ repo, scheduled }).setSendAt("25:00")).rejects.toThrow();

    expect(row.sendAt).toBe("07:30");
    expect(scheduled).toEqual([]);
  });
});

describe("renderBriefing", () => {
  const base: BriefingData = {
    date: "2026-09-09",
    events: [],
    tasks: [],
    empty: true,
    calendarUnavailable: false,
  };

  it("says plainly that there is nothing, instead of saying nothing", () => {
    const text = renderBriefing(base);

    // E6: an empty briefing is still a briefing. Silence is indistinguishable
    // from a job that never ran.
    expect(text).toContain("Nessun impegno");
    expect(text).toContain("Nessun task");
  });

  it("lists events and marks a late task", () => {
    const text = renderBriefing({
      ...base,
      events: [{ summary: "revisione", allDay: false, start: "08:00", end: "09:00" }],
      tasks: [{ title: "send invoice", project: "Atlas", dueOn: "2026-09-05", overdue: true }],
      empty: false,
    });

    expect(text).toContain("08:00–09:00 revisione");
    expect(text).toContain("send invoice [Atlas]");
    expect(text).toContain("in ritardo dal 2026-09-05");
  });

  it("does not claim the day is free when the calendar was unreadable", () => {
    const text = renderBriefing({ ...base, calendarUnavailable: true });

    expect(text).not.toContain("Nessun impegno");
    expect(text).toContain("Calendario non leggibile");
  });
});
