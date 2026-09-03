import { google, type calendar_v3 } from "googleapis";
import type { CalendarEvent, CalendarPort } from "../../domain/calendar/port.js";
import { InvalidInputError, NotFoundError } from "../../domain/errors.js";

/**
 * Google Calendar adapter.
 *
 * Authentication is a service account with the calendar shared to it, not an
 * OAuth consent flow. An OAuth app kept in Google's "testing" state hands out
 * refresh tokens that expire every seven days, and publishing one requires a
 * domain, a privacy policy and a review — all to protect users of an app that
 * has exactly one. The service account has no expiry and no browser step, at
 * the cost of being a separate identity: it can manage the calendar shared
 * with it, but it cannot invite anyone as you.
 */

/** Least privilege: enough to read and write events, nothing else. */
export const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

export interface GoogleCalendarOptions {
  /** Path to the service account key JSON. Never committed. */
  keyFile: string;
  /** The calendar the key has been granted access to — normally your address. */
  calendarId: string;
}

/** Google reports a missing or inaccessible resource as 404. */
function isNotFound(err: unknown): boolean {
  const code =
    (err as { code?: unknown; status?: unknown })?.code ?? (err as { status?: unknown })?.status;
  return code === 404 || code === "404";
}

/**
 * Google returns `dateTime` for timed events and `date` for all-day ones.
 * An all-day `end` is exclusive, which matters when it is drawn on a timeline.
 */
function readBoundary(
  point: calendar_v3.Schema$EventDateTime | undefined,
): { at: Date; allDay: boolean } | undefined {
  if (point?.dateTime) return { at: new Date(point.dateTime), allDay: false };
  if (point?.date) return { at: new Date(`${point.date}T00:00:00Z`), allDay: true };
  return undefined;
}

function toEvent(raw: calendar_v3.Schema$Event): CalendarEvent | undefined {
  const start = readBoundary(raw.start ?? undefined);
  const end = readBoundary(raw.end ?? undefined);
  // A cancelled occurrence of a series comes back with no times at all.
  if (!raw.id || !start || !end) return undefined;

  return {
    id: raw.id,
    summary: raw.summary ?? "(no title)",
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.location ? { location: raw.location } : {}),
    start: start.at,
    end: end.at,
    allDay: start.allDay,
    ...(raw.recurringEventId ? { seriesId: raw.recurringEventId } : {}),
  };
}

export function createGoogleCalendar(opts: GoogleCalendarOptions): CalendarPort {
  const auth = new google.auth.GoogleAuth({
    keyFile: opts.keyFile,
    scopes: CALENDAR_SCOPES,
  });
  const api = google.calendar({ version: "v3", auth });
  const calendarId = opts.calendarId;

  /** Turns Google's 404 into the domain error the model is allowed to see. */
  async function guarded<T>(eventId: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isNotFound(err)) throw new NotFoundError(`No calendar event with id "${eventId}".`);
      throw err;
    }
  }

  function requireEvent(raw: calendar_v3.Schema$Event | undefined, eventId: string): CalendarEvent {
    const event = raw ? toEvent(raw) : undefined;
    if (!event) throw new NotFoundError(`No calendar event with id "${eventId}".`);
    return event;
  }

  return {
    async list({ from, to, limit }) {
      const res = await api.events.list({
        calendarId,
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        // Expand recurring series into their occurrences, so "what is on
        // Tuesday" answers with that Tuesday rather than with a rule.
        singleEvents: true,
        orderBy: "startTime",
        maxResults: limit,
      });
      return (res.data.items ?? []).map(toEvent).filter((e): e is CalendarEvent => e !== undefined);
    },

    async get(eventId) {
      return guarded(eventId, async () => {
        const res = await api.events.get({ calendarId, eventId });
        return requireEvent(res.data, eventId);
      });
    },

    async create({ summary, start, end, description, location }) {
      if (end.getTime() <= start.getTime()) {
        throw new InvalidInputError("An event must end after it starts.");
      }
      const res = await api.events.insert({
        calendarId,
        requestBody: {
          summary,
          ...(description ? { description } : {}),
          ...(location ? { location } : {}),
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
        },
      });
      return requireEvent(res.data, "(new)");
    },

    async update(eventId, patch) {
      return guarded(eventId, async () => {
        // Reading first is what makes a partial move safe: shifting only the
        // start must still be checked against the end already on the event.
        const current = requireEvent((await api.events.get({ calendarId, eventId })).data, eventId);
        const start = patch.start ?? current.start;
        const end = patch.end ?? current.end;
        if (end.getTime() <= start.getTime()) {
          throw new InvalidInputError("An event must end after it starts.");
        }

        // PATCH, not PUT: on an occurrence of a series this edits that
        // occurrence and leaves the rest of the series alone.
        const res = await api.events.patch({
          calendarId,
          eventId,
          requestBody: {
            ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.location !== undefined ? { location: patch.location } : {}),
            ...(patch.start ? { start: { dateTime: patch.start.toISOString() } } : {}),
            ...(patch.end ? { end: { dateTime: patch.end.toISOString() } } : {}),
          },
        });
        return requireEvent(res.data, eventId);
      });
    },

    async delete(eventId) {
      await guarded(eventId, () => api.events.delete({ calendarId, eventId }));
    },
  };
}
