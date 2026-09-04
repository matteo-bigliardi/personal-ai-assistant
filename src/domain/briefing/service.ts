import type { BriefingRepository } from "../../db/repositories/briefing.js";
import type { Logger } from "../../observability/logger.js";
import type { CalendarEvent } from "../calendar/port.js";
import type { CalendarService } from "../calendar/service.js";
import {
  endOfDay,
  formatCivilDate,
  formatClock,
  startOfDay,
  startOfDayAfter,
} from "../datetime.js";
import { InvalidInputError } from "../errors.js";
import type { TasksService } from "../tasks/service.js";

/**
 * The morning briefing, as data.
 *
 * Everything here is deterministic: the day's events and the tasks that are due
 * are read by calling the same services the tools call, with no model and no
 * tool loop involved. The model's only job, one layer up, is turning this into
 * a few readable lines — so it cannot forget to look at the tasks, and it
 * cannot decide to go and read something else instead.
 */

const EVENT_LIMIT = 20;
const TASK_LIMIT = 20;

/** `HH:MM`, 24-hour. The same shape the database CHECK enforces. */
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export interface BriefingEvent {
  summary: string;
  allDay: boolean;
  /** `HH:MM` local; absent on an all-day event, which owns no hours. */
  start?: string;
  end?: string;
}

export interface BriefingTask {
  title: string;
  project: string | null;
  /** `YYYY-MM-DD` local. */
  dueOn: string;
  overdue: boolean;
}

export interface BriefingData {
  /** Local calendar date the briefing is about. */
  date: string;
  events: BriefingEvent[];
  tasks: BriefingTask[];
  /** True when there is genuinely nothing to report. */
  empty: boolean;
  /**
   * The calendar could not be read. Deliberately distinct from "no events":
   * one means a free day, the other means we do not know, and a briefing that
   * confused the two would be worse than one that admits it.
   */
  calendarUnavailable: boolean;
}

/** Reschedules the delivery job when the time changes. Implemented in `jobs/`. */
export interface BriefingScheduler {
  reschedule(sendAt: string): Promise<void>;
}

export interface BriefingService {
  collect(now: Date): Promise<BriefingData>;
  getSendAt(): Promise<string>;
  setSendAt(raw: string): Promise<string>;
}

/** Validates `HH:MM` and normalises `7:30` to `07:30`. */
export function parseSendAt(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new InvalidInputError("A briefing time must be a string like 07:30.");
  }
  const trimmed = raw.trim();
  const padded = /^\d:\d\d$/.test(trimmed) ? `0${trimmed}` : trimmed;
  if (!TIME_PATTERN.test(padded)) {
    throw new InvalidInputError(
      `"${String(raw)}" is not a time of day. Use 24-hour HH:MM, for example 07:30.`,
    );
  }
  return padded;
}

function toBriefingEvent(event: CalendarEvent, timeZone: string): BriefingEvent {
  if (event.allDay) return { summary: event.summary, allDay: true };
  return {
    summary: event.summary,
    allDay: false,
    start: formatClock(event.start, timeZone),
    end: formatClock(event.end, timeZone),
  };
}

export interface BriefingServiceOptions {
  repo: BriefingRepository;
  tasks: TasksService;
  /** Absent when the calendar integration is not configured. */
  calendar?: CalendarService | undefined;
  scheduler: BriefingScheduler;
  logger: Logger;
  timeZone: string;
}

export function createBriefingService(opts: BriefingServiceOptions): BriefingService {
  const { repo, tasks, calendar, scheduler, logger, timeZone } = opts;

  async function readEvents(now: Date): Promise<{ events: CalendarEvent[]; failed: boolean }> {
    if (!calendar) return { events: [], failed: true };
    try {
      const events = await calendar.list({
        from: startOfDay(now, timeZone),
        to: startOfDayAfter(now, timeZone),
        limit: EVENT_LIMIT,
      });
      return { events, failed: false };
    } catch (err) {
      // A briefing that arrives without the calendar beats no briefing at all,
      // as long as it says which half is missing.
      logger.error("briefing.calendar_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { events: [], failed: true };
    }
  }

  return {
    async collect(now) {
      const dayStart = startOfDay(now, timeZone);
      const [calendarResult, dueTasks] = await Promise.all([
        readEvents(now),
        // `dueBefore` is inclusive, and the end of today is what a deadline
        // given as a bare date means — so this is today's work plus everything
        // already late, which is the same question the user is asking.
        tasks.list({ dueBefore: endOfDay(now, timeZone), limit: TASK_LIMIT }),
      ]);

      const briefingTasks: BriefingTask[] = dueTasks.map((task) => {
        // `dueBefore` excludes undated tasks, so every row here has a deadline.
        const dueAt = task.dueAt as Date;
        return {
          title: task.title,
          project: task.projectName,
          dueOn: formatCivilDate(dueAt, timeZone),
          overdue: dueAt.getTime() < dayStart.getTime(),
        };
      });

      return {
        date: formatCivilDate(now, timeZone),
        events: calendarResult.events.map((event) => toBriefingEvent(event, timeZone)),
        tasks: briefingTasks,
        empty: calendarResult.events.length === 0 && briefingTasks.length === 0,
        calendarUnavailable: calendarResult.failed,
      };
    },

    async getSendAt() {
      const row = await repo.get();
      if (!row) throw new Error("briefing settings row missing");
      return row.sendAt;
    },

    async setSendAt(raw) {
      const sendAt = parseSendAt(raw);
      const row = await repo.setSendAt(sendAt);
      // Persist first, reschedule second. A stored time the queue has not
      // picked up yet is corrected at the next start; a rescheduled job with no
      // row behind it has nothing to be corrected from.
      await scheduler.reschedule(row.sendAt);
      return row.sendAt;
    },
  };
}

/**
 * The briefing as plain text, written without a model.
 *
 * Used when the provider is unreachable, and as the material the model is asked
 * to improve on. It always says something: the briefing goes out every morning
 * whether or not there is anything in it, because silence is ambiguous — it
 * looks exactly like a job that never ran.
 */
export function renderBriefing(data: BriefingData): string {
  const lines: string[] = [];

  if (data.events.length > 0) {
    lines.push("Oggi:");
    for (const event of data.events) {
      lines.push(
        event.allDay
          ? `• ${event.summary} (tutto il giorno)`
          : `• ${event.start}–${event.end} ${event.summary}`,
      );
    }
  } else if (!data.calendarUnavailable) {
    lines.push("Nessun impegno in calendario oggi.");
  }

  if (data.calendarUnavailable) lines.push("Calendario non leggibile stamattina.");

  if (data.tasks.length > 0) {
    lines.push("Task:");
    for (const task of data.tasks) {
      const project = task.project ? ` [${task.project}]` : "";
      const late = task.overdue ? ` (in ritardo dal ${task.dueOn})` : "";
      lines.push(`• ${task.title}${project}${late}`);
    }
  } else {
    lines.push("Nessun task in scadenza.");
  }

  return lines.join("\n");
}
