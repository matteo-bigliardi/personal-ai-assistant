/**
 * The calendar, as the domain needs it.
 *
 * Google is authoritative for appointments and is never mirrored into Postgres,
 * but the rules and the tools must not import `googleapis`: this port is the
 * seam. It also means the domain can be tested against a fake without an
 * account, which is the only way the interesting cases get covered at all.
 */

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string | undefined;
  location?: string | undefined;
  start: Date;
  end: Date;
  /**
   * All-day events carry a date, not an instant. They are still real events,
   * but they say nothing about which hours are taken.
   */
  allDay: boolean;
  /** Set when this event is one occurrence of a recurring series. */
  seriesId?: string | undefined;
}

export interface CreateEventInput {
  summary: string;
  start: Date;
  end: Date;
  description?: string | undefined;
  location?: string | undefined;
}

export interface UpdateEventInput {
  summary?: string | undefined;
  start?: Date | undefined;
  end?: Date | undefined;
  description?: string | undefined;
  location?: string | undefined;
}

export interface CalendarPort {
  /** Events overlapping `[from, to)`, soonest first, recurrences expanded. */
  list(input: { from: Date; to: Date; limit: number }): Promise<CalendarEvent[]>;
  get(eventId: string): Promise<CalendarEvent>;
  create(input: CreateEventInput): Promise<CalendarEvent>;
  /** Updates one event; on a recurring series this is a single occurrence. */
  update(eventId: string, patch: UpdateEventInput): Promise<CalendarEvent>;
  delete(eventId: string): Promise<void>;
}
