import type { CalendarEvent, CalendarPort } from "./port.js";
import { findFreeSlots, type Interval } from "./free-slots.js";
import { InvalidInputError } from "../errors.js";

/**
 * Calendar rules, independent of Telegram, of the model and of Google.
 *
 * Google is authoritative for appointments (spec §3.1), so nothing here caches
 * or mirrors: every answer comes from a live read.
 */

export const MAX_SUMMARY_LENGTH = 200;
export const MAX_TEXT_LENGTH = 1000;

/** A single request should never drag an unbounded slice of the calendar in. */
export const MAX_RANGE_DAYS = 62;

export interface FreeSlotsResult {
  slots: Interval[];
  /**
   * All-day events overlapping the window, which are reported rather than
   * treated as busy — see `findFree`.
   */
  allDay: CalendarEvent[];
}

export interface CalendarService {
  list(input: { from: Date; to: Date; limit: number }): Promise<CalendarEvent[]>;
  create(input: {
    summary: string;
    start: Date;
    end: Date;
    description?: string | undefined;
    location?: string | undefined;
  }): Promise<CalendarEvent>;
  update(
    eventId: string,
    patch: {
      summary?: string | undefined;
      start?: Date | undefined;
      end?: Date | undefined;
      description?: string | undefined;
      location?: string | undefined;
    },
  ): Promise<CalendarEvent>;
  /** Reads the event first, so the caller can say what is about to go. */
  get(eventId: string): Promise<CalendarEvent>;
  delete(eventId: string): Promise<CalendarEvent>;
  findFree(input: {
    from: Date;
    to: Date;
    minimumMinutes: number;
    limit: number;
  }): Promise<FreeSlotsResult>;
}

function normaliseText(raw: string | undefined, max: number, what: string): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim().replace(/\s+/g, " ");
  if (text.length > max) {
    throw new InvalidInputError(`A ${what} cannot exceed ${max} characters.`);
  }
  return text;
}

function assertRange(from: Date, to: Date): void {
  if (to.getTime() <= from.getTime()) {
    throw new InvalidInputError("The range ends before it starts.");
  }
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days > MAX_RANGE_DAYS) {
    throw new InvalidInputError(`A range cannot span more than ${MAX_RANGE_DAYS} days.`);
  }
}

export function createCalendarService(calendar: CalendarPort): CalendarService {
  return {
    async list({ from, to, limit }) {
      assertRange(from, to);
      return calendar.list({ from, to, limit });
    },

    async create({ summary, start, end, description, location }) {
      const title = normaliseText(summary, MAX_SUMMARY_LENGTH, "title");
      if (!title) throw new InvalidInputError("An event needs a title.");
      if (end.getTime() <= start.getTime()) {
        throw new InvalidInputError("An event must end after it starts.");
      }
      return calendar.create({
        summary: title,
        start,
        end,
        ...(description !== undefined
          ? { description: normaliseText(description, MAX_TEXT_LENGTH, "description") }
          : {}),
        ...(location !== undefined
          ? { location: normaliseText(location, MAX_TEXT_LENGTH, "location") }
          : {}),
      });
    },

    async update(eventId, patch) {
      if (Object.values(patch).every((v) => v === undefined)) {
        throw new InvalidInputError(
          "Nothing to update: provide a title, time, description or location.",
        );
      }
      if (patch.summary !== undefined) {
        const title = normaliseText(patch.summary, MAX_SUMMARY_LENGTH, "title");
        if (!title) throw new InvalidInputError("An event needs a title.");
      }
      return calendar.update(eventId, patch);
    },

    get: (eventId) => calendar.get(eventId),

    async delete(eventId) {
      // Read before deleting: the caller has to be able to report what went,
      // and after the delete there is nothing left to describe.
      const event = await calendar.get(eventId);
      await calendar.delete(eventId);
      return event;
    },

    /**
     * All-day events are reported, not treated as busy.
     *
     * They carry no hours, and most of them — a birthday, a public holiday, a
     * "release week" banner — say nothing about availability. Blocking on them
     * would empty the answer for any day that has one. But some of them do
     * mean the day is gone, so they come back alongside the slots and the
     * assistant can mention them rather than quietly ignore them.
     */
    async findFree({ from, to, minimumMinutes, limit }) {
      assertRange(from, to);
      const events = await calendar.list({ from, to, limit: 250 });

      const busy = events.filter((e) => !e.allDay).map((e) => ({ start: e.start, end: e.end }));

      return {
        slots: findFreeSlots({ window: { start: from, end: to }, busy, minimumMinutes, limit }),
        allDay: events.filter((e) => e.allDay),
      };
    },
  };
}
