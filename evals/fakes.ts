import type { Project, Reminder, Task } from "../src/db/schema.js";
import type { TaskWithProject } from "../src/db/repositories/tasks.js";
import type { WorkSessionWithProject } from "../src/db/repositories/work-sessions.js";
import type { BriefingService } from "../src/domain/briefing/service.js";
import type { CalendarEvent } from "../src/domain/calendar/port.js";
import type { CalendarService } from "../src/domain/calendar/service.js";
import { NotFoundError } from "../src/domain/errors.js";
import type { ProjectsService } from "../src/domain/projects/service.js";
import type { RemindersService } from "../src/domain/reminders/service.js";
import type { TasksService } from "../src/domain/tasks/service.js";
import type { TimeService } from "../src/domain/time/service.js";

/**
 * Stand-ins for the domain services, behind the real tool definitions.
 *
 * What is being measured here is whether the model picks the right tool and
 * fills it in correctly, which depends on the tool schemas and descriptions —
 * all of which stay real. What happens after that is the domain's business and
 * is covered by the unit and integration suites, so these fakes only need to
 * answer plausibly and never write anything down. That also means an eval run
 * cannot touch the database, the calendar or the user's data.
 *
 * The fixtures are synthetic and fixed, so a case can refer to "Atlas" or to
 * task `a1b2c3d4` and get the same answer on every run and every machine.
 */

const AT = (iso: string) => new Date(iso);

export const PROJECTS: Project[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Atlas",
    description: "Demo platform",
    status: "active",
    createdAt: AT("2026-09-01T08:00:00Z"),
    updatedAt: AT("2026-09-01T08:00:00Z"),
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    name: "Borealis",
    description: null,
    status: "paused",
    createdAt: AT("2026-09-01T08:00:00Z"),
    updatedAt: AT("2026-09-01T08:00:00Z"),
  },
];

export const TASKS: TaskWithProject[] = [
  {
    id: "a1b2c3d4-0000-0000-0000-000000000000",
    projectId: PROJECTS[0]!.id,
    title: "prepare the demo",
    description: null,
    status: "open",
    priority: "high",
    dueAt: AT("2026-09-11T21:59:59Z"),
    createdAt: AT("2026-09-01T08:00:00Z"),
    updatedAt: AT("2026-09-01T08:00:00Z"),
    completedAt: null,
    projectName: "Atlas",
  },
  {
    id: "e5f6a7b8-0000-0000-0000-000000000000",
    projectId: null,
    title: "renew the domain",
    description: null,
    status: "open",
    priority: null,
    dueAt: AT("2026-09-04T21:59:59Z"),
    createdAt: AT("2026-09-01T08:00:00Z"),
    updatedAt: AT("2026-09-01T08:00:00Z"),
    completedAt: null,
    projectName: null,
  },
];

/** The frozen clock the eval runs against; see evals/run.ts. */
const NOW = AT("2026-09-09T06:00:00Z");

export const REMINDERS: Reminder[] = [
  {
    // Still pending, so it can be snoozed only after delivery but cancelled now.
    id: "b0b1b2b3-0000-0000-0000-000000000000",
    chatId: "eval",
    message: "call the bank",
    dueAt: AT("2026-09-09T16:00:00Z"),
    status: "pending",
    jobId: null,
    snoozeCount: 0,
    createdAt: AT("2026-09-09T06:00:00Z"),
    updatedAt: AT("2026-09-09T06:00:00Z"),
    deliveredAt: null,
  },
  {
    id: "c9d8e7f6-0000-0000-0000-000000000000",
    chatId: "eval",
    message: "check the build",
    dueAt: AT("2026-09-09T14:00:00Z"),
    status: "delivered",
    jobId: null,
    snoozeCount: 0,
    createdAt: AT("2026-09-09T12:00:00Z"),
    updatedAt: AT("2026-09-09T12:00:00Z"),
    deliveredAt: AT("2026-09-09T14:00:00Z"),
  },
];

export const EVENTS: CalendarEvent[] = [
  {
    id: "evt-standup",
    summary: "standup",
    start: AT("2026-09-09T07:00:00Z"),
    end: AT("2026-09-09T07:15:00Z"),
    allDay: false,
  },
  {
    id: "evt-review",
    summary: "design review",
    start: AT("2026-09-09T14:00:00Z"),
    end: AT("2026-09-09T15:00:00Z"),
    allDay: false,
  },
];

function projectByName(name: string): Project {
  const found = PROJECTS.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  if (!found) throw new NotFoundError(`No project named "${name}".`);
  return found;
}

function taskByRef(ref: string): TaskWithProject {
  const found = TASKS.find((t) => t.id.startsWith(ref.trim().toLowerCase()));
  if (!found) throw new NotFoundError(`No task with id "${ref}".`);
  return found;
}

export function fakeServices(): {
  projects: ProjectsService;
  tasks: TasksService;
  time: TimeService;
  reminders: RemindersService;
  calendar: CalendarService;
  briefing: BriefingService;
} {
  const session: WorkSessionWithProject = {
    id: "0f0f0f0f-0000-0000-0000-000000000000",
    projectId: PROJECTS[0]!.id,
    startedAt: AT("2026-09-09T08:00:00Z"),
    endedAt: null,
    note: null,
    projectName: "Atlas",
  };

  return {
    projects: {
      async create({ name, description }) {
        return { ...PROJECTS[0]!, name, description: description ?? null };
      },
      async list() {
        return PROJECTS;
      },
      async getByName(name) {
        return projectByName(name);
      },
      async update(name, patch) {
        return { ...projectByName(name), ...(patch.status ? { status: patch.status } : {}) };
      },
    },

    tasks: {
      async create({ title, projectName, priority, dueAt }) {
        return {
          ...TASKS[0]!,
          title,
          priority: priority ?? null,
          dueAt: dueAt ?? null,
          projectName: projectName ?? null,
        };
      },
      async list() {
        return TASKS;
      },
      async getByRef(ref) {
        return taskByRef(ref);
      },
      async complete(ref) {
        const task = taskByRef(ref);
        return {
          task: { ...task, status: "done" as Task["status"], completedAt: AT("2026-09-09T08:00:00Z") },
          alreadyDone: false,
        };
      },
      async update(ref, patch) {
        const task = taskByRef(ref);
        return { ...task, ...(patch.status ? { status: patch.status } : {}) };
      },
    },

    time: {
      async start(projectName) {
        return { ...session, projectName: projectByName(projectName).name };
      },
      async stop() {
        return { session: { ...session, endedAt: AT("2026-09-09T09:30:00Z") }, seconds: 5400 };
      },
      async add({ projectName, startedAt, endedAt }) {
        return { ...session, projectName: projectByName(projectName).name, startedAt, endedAt };
      },
      async report({ projectName }) {
        return {
          range: { from: AT("2026-09-07T00:00:00Z"), to: AT("2026-09-14T00:00:00Z") },
          totalSeconds: 7200,
          byProject: [{ projectName: projectName ?? "Atlas", seconds: 7200 }],
        };
      },
    },

    reminders: {
      async create({ message, at, inMinutes }) {
        const dueAt = at ?? new Date(NOW.getTime() + (inMinutes ?? 0) * 60_000);
        return { ...REMINDERS[0]!, message, dueAt, status: "pending" };
      },
      async list() {
        return REMINDERS;
      },
      async snooze(ref, minutes) {
        const found = REMINDERS.find((r) => r.id.startsWith(ref.trim().toLowerCase()));
        if (!found) throw new NotFoundError(`No reminder with id "${ref}".`);
        return {
          ...found,
          status: "snoozed",
          dueAt: new Date(found.dueAt.getTime() + minutes * 60_000),
          snoozeCount: found.snoozeCount + 1,
        };
      },
      async cancel(ref) {
        const found = REMINDERS.find((r) => r.id.startsWith(ref.trim().toLowerCase()));
        if (!found) throw new NotFoundError(`No reminder with id "${ref}".`);
        return { ...found, status: "cancelled" };
      },
    },

    calendar: {
      async list() {
        return EVENTS;
      },
      async create({ summary, start, end }) {
        return { id: "evt-new", summary, start, end, allDay: false };
      },
      async update(eventId, patch) {
        const found = EVENTS.find((e) => e.id === eventId);
        if (!found) throw new NotFoundError(`No event with id "${eventId}".`);
        // The whole patch is applied, end included. Applying only the start
        // returned a zero-length event, and the model — correctly — kept
        // retrying to fix what looked like a broken write.
        return {
          ...found,
          ...(patch.summary ? { summary: patch.summary } : {}),
          ...(patch.start ? { start: patch.start } : {}),
          ...(patch.end ? { end: patch.end } : {}),
        };
      },
      async get(eventId) {
        const found = EVENTS.find((e) => e.id === eventId);
        if (!found) throw new NotFoundError(`No event with id "${eventId}".`);
        return found;
      },
      async delete(eventId) {
        const found = EVENTS.find((e) => e.id === eventId);
        if (!found) throw new NotFoundError(`No event with id "${eventId}".`);
        return found;
      },
      async findFree({ from, to }) {
        return { slots: [{ start: from, end: to }], allDay: [] };
      },
    },

    briefing: {
      async collect() {
        return {
          date: "2026-09-09",
          events: [],
          tasks: [],
          empty: true,
          calendarUnavailable: false,
        };
      },
      async getSendAt() {
        return "07:30";
      },
      async setSendAt(raw) {
        return String(raw);
      },
    },
  };
}
