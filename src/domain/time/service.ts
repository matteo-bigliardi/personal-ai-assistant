import type {
  WorkSessionsRepository,
  WorkSessionWithProject,
} from "../../db/repositories/work-sessions.js";
import type { ProjectsService } from "../projects/service.js";
import type { Project } from "../../db/schema.js";
import { ConflictError, InvalidInputError, PreconditionFailedError } from "../errors.js";
import {
  dayRange,
  startOfDay,
  startOfDayAfter,
  startOfMonth,
  startOfNextMonth,
  startOfWeek,
} from "../datetime.js";

/**
 * Work-time rules, independent of Telegram, of the model and of SQL.
 *
 * Only one timer runs at a time, and that is enforced by a partial unique index
 * rather than by the checks here: the checks exist to produce an explanation
 * the model can act on, not to be the last line of defence.
 */

export const MAX_NOTE_LENGTH = 200;

/**
 * A timer may run on a paused project. Pausing records an intention, and if you
 * are working on it right now then it is not paused any more — forcing the user
 * to change the status first would be friction with nothing behind it. Finished
 * and archived projects are a different matter: logging new work against them
 * almost always means the wrong project was named.
 */
const CLOSED_TO_NEW_WORK: Project["status"][] = ["completed", "archived"];

/** The periods the assistant can be asked about by name. */
export const TIME_PERIODS = ["today", "this_week", "this_month", "all_time"] as const;

export type TimePeriod = (typeof TIME_PERIODS)[number];

export interface TimeRange {
  from?: Date | undefined;
  to?: Date | undefined;
}

export interface ProjectTotal {
  projectName: string;
  seconds: number;
}

export interface TimeReport {
  range: TimeRange;
  totalSeconds: number;
  byProject: ProjectTotal[];
  /** Present when a timer is running and its time is part of the totals. */
  running?: { projectName: string; startedAt: Date; countedSeconds: number };
}

export interface TimeService {
  start(projectName: string, note?: string | undefined): Promise<WorkSessionWithProject>;
  stop(): Promise<{ session: WorkSessionWithProject; seconds: number }>;
  add(input: {
    projectName: string;
    startedAt: Date;
    endedAt: Date;
    note?: string | undefined;
  }): Promise<WorkSessionWithProject>;
  report(input: {
    projectName?: string | undefined;
    period?: TimePeriod | undefined;
    from?: string | undefined;
    to?: string | undefined;
  }): Promise<TimeReport>;
}

function normaliseNote(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const note = raw.trim();
  if (note.length === 0) return null;
  if (note.length > MAX_NOTE_LENGTH) {
    throw new InvalidInputError(`A note cannot exceed ${MAX_NOTE_LENGTH} characters.`);
  }
  return note;
}

/**
 * `work_sessions_ended_after_started` is a strict `>`: a session that starts
 * and ends in the same second is rejected by the database. That is deliberate
 * — a work session with no duration is not a fact worth storing — but the
 * refusal has to arrive as an explanation rather than as a constraint
 * violation the model cannot interpret.
 */
function assertPositiveDuration(startedAt: Date, endedAt: Date, what: string): void {
  if (endedAt.getTime() > startedAt.getTime()) return;
  throw new InvalidInputError(
    endedAt.getTime() === startedAt.getTime()
      ? `${what} would have no duration: it starts and ends at the same moment.`
      : `${what} would end before it started.`,
  );
}

/** Seconds of a session that fall inside `[from, to)`, clipped at both ends. */
function secondsInRange(
  session: { startedAt: Date; endedAt: Date | null },
  range: TimeRange,
  now: Date,
): number {
  // A running session is counted up to this instant: someone who has been on
  // Atlas for an hour is not helped by being told they have done nothing today.
  const end = session.endedAt ?? now;
  const startMs = Math.max(session.startedAt.getTime(), range.from?.getTime() ?? -Infinity);
  const endMs = Math.min(end.getTime(), range.to?.getTime() ?? Infinity);
  return Math.max(0, (endMs - startMs) / 1000);
}

export function createTimeService(
  repo: WorkSessionsRepository,
  projects: ProjectsService,
  timeZone: string,
  clock: () => Date = () => new Date(),
): TimeService {
  /** Resolves the named period, or an explicit date range, to half-open bounds. */
  function resolveRange(period: TimePeriod | undefined, from?: string, to?: string): TimeRange {
    if (from !== undefined || to !== undefined) {
      if (period !== undefined) {
        throw new InvalidInputError("Give either a named period or a date range, not both.");
      }
      // Half-open throughout: the upper bound is the start of the day after the
      // last one asked for, so the final day is included whole.
      return {
        ...(from !== undefined ? { from: dayRange(from, timeZone).from } : {}),
        ...(to !== undefined ? { to: dayRange(to, timeZone).to } : {}),
      };
    }

    const now = clock();
    switch (period ?? "all_time") {
      case "today":
        return { from: startOfDay(now, timeZone), to: startOfDayAfter(now, timeZone) };
      case "this_week":
        return {
          from: startOfWeek(now, timeZone),
          to: startOfDayAfter(startOfWeek(now, timeZone), timeZone, 7),
        };
      case "this_month":
        return { from: startOfMonth(now, timeZone), to: startOfNextMonth(now, timeZone) };
      case "all_time":
        return {};
    }
  }

  async function resolveOpenProject(name: string): Promise<Project> {
    const project = await projects.getByName(name);
    if (CLOSED_TO_NEW_WORK.includes(project.status)) {
      throw new PreconditionFailedError(
        `Project "${project.name}" is ${project.status}, so no new work can be logged against it.`,
      );
    }
    return project;
  }

  return {
    async start(projectName, note) {
      const project = await resolveOpenProject(projectName);

      // Refuse rather than stopping the running timer and starting a new one:
      // that would close a session the user never asked to close, and if the
      // project name was a slip the tracked time is wrong with no trace. Naming
      // the running project lets the model offer the stop in the same turn.
      const running = await repo.findActive();
      if (running) {
        throw new ConflictError(
          `A timer is already running on "${running.projectName}". Stop it before starting another.`,
        );
      }

      const started = await repo.start({
        projectId: project.id,
        startedAt: clock(),
        note: normaliseNote(note),
      });
      return { ...started, projectName: project.name };
    },

    async stop() {
      const active = await repo.findActive();
      if (!active) throw new PreconditionFailedError("No timer is running.");

      const endedAt = clock();
      // The CHECK is a strict `>`, so a timer stopped within the same second it
      // started cannot be written. Say what to do about it: waiting a moment
      // and asking again is all it takes, and the timer is not lost meanwhile.
      if (endedAt.getTime() <= active.startedAt.getTime()) {
        throw new InvalidInputError(
          "The timer has been running for less than a second. Wait a moment and stop it again.",
        );
      }

      const stopped = await repo.stop(active.id, endedAt);
      // The row was open a moment ago; if it is not any more, something else
      // closed it and the user should be told rather than shown a stale total.
      if (!stopped) throw new ConflictError("The timer was stopped by something else.");

      return {
        session: { ...stopped, projectName: active.projectName },
        seconds: (endedAt.getTime() - active.startedAt.getTime()) / 1000,
      };
    },

    async add({ projectName, startedAt, endedAt, note }) {
      const project = await resolveOpenProject(projectName);
      assertPositiveDuration(startedAt, endedAt, "That work session");

      const added = await repo.add({
        projectId: project.id,
        startedAt,
        endedAt,
        note: normaliseNote(note),
      });
      return { ...added, projectName: project.name };
    },

    async report({ projectName, period, from, to }) {
      const range = resolveRange(period, from, to);
      if (range.from && range.to && range.to.getTime() <= range.from.getTime()) {
        throw new InvalidInputError("The end of the range is not after its start.");
      }

      const project = projectName ? await projects.getByName(projectName) : undefined;
      const sessions = await repo.listOverlapping({
        ...(project ? { projectId: project.id } : {}),
        ...range,
      });

      const now = clock();
      const totals = new Map<string, number>();
      let totalSeconds = 0;
      let running: TimeReport["running"];

      for (const session of sessions) {
        const seconds = secondsInRange(session, range, now);
        if (seconds <= 0) continue;

        totals.set(session.projectName, (totals.get(session.projectName) ?? 0) + seconds);
        totalSeconds += seconds;

        if (session.endedAt === null) {
          running = {
            projectName: session.projectName,
            startedAt: session.startedAt,
            countedSeconds: seconds,
          };
        }
      }

      const byProject = [...totals]
        .map(([name, seconds]) => ({ projectName: name, seconds }))
        .sort((a, b) => b.seconds - a.seconds);

      return { range, totalSeconds, byProject, ...(running ? { running } : {}) };
    },
  };
}
