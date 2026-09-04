import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tool-registry.js";
import {
  MAX_SUMMARY_LENGTH,
  MAX_TEXT_LENGTH,
  type CalendarService,
} from "../../domain/calendar/service.js";
import type { CalendarEvent } from "../../domain/calendar/port.js";
import {
  INSTANT_FORMAT_HINT,
  formatDuration,
  formatInstant,
  parseInstant,
} from "../../domain/datetime.js";

/**
 * Calendar tools.
 *
 * Google is authoritative for appointments, so every one of these reads or
 * writes live — nothing is served from a local copy. Events are addressed by
 * the id Google gives them, which is why every listing carries it.
 */

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const DEFAULT_SLOT_LIMIT = 5;

const eventIdArg = z
  .string()
  .min(1)
  .max(1024)
  .describe("The event id, exactly as returned by list_calendar_events.");

const fromArg = z.string().min(1).max(40).describe(`Start of the range: ${INSTANT_FORMAT_HINT}.`);
const toArg = z.string().min(1).max(40).describe(`End of the range: ${INSTANT_FORMAT_HINT}.`);

interface EventView {
  id: string;
  title: string;
  start: string;
  end: string;
  duration: string;
  all_day?: true;
  part_of_series?: true;
  location?: string;
  description?: string;
}

function view(event: CalendarEvent, timeZone: string): EventView {
  return {
    id: event.id,
    title: event.summary,
    start: formatInstant(event.start, timeZone),
    end: formatInstant(event.end, timeZone),
    duration: formatDuration((event.end.getTime() - event.start.getTime()) / 1000),
    ...(event.allDay ? { all_day: true as const } : {}),
    // Flagged so the assistant can say a change touched one occurrence and not
    // the whole series, rather than leaving the user to assume either way.
    ...(event.seriesId ? { part_of_series: true as const } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.description ? { description: event.description } : {}),
  };
}

export function createCalendarTools(service: CalendarService, timeZone: string): ToolDefinition[] {
  return [
    defineTool({
      name: "list_calendar_events",
      description:
        "List calendar events overlapping a time range, soonest first. This is how to answer " +
        "what is on the agenda, and the only way to get the event ids the other calendar " +
        "tools need. Recurring events are expanded into their occurrences.",
      schema: z.object({
        from: fromArg,
        to: toArg,
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIST_LIMIT)
          .optional()
          .describe(`Maximum events to return (default ${DEFAULT_LIST_LIMIT}).`),
      }),
      async execute({ from, to, limit }) {
        const events = await service.list({
          from: parseInstant(from),
          to: parseInstant(to),
          limit: limit ?? DEFAULT_LIST_LIMIT,
        });
        return { count: events.length, events: events.map((e) => view(e, timeZone)) };
      },
    }),

    defineTool({
      name: "create_calendar_event",
      description: "Create an event on the calendar. Both ends are absolute instants.",
      schema: z.object({
        title: z.string().min(1).max(MAX_SUMMARY_LENGTH).describe("What the event is."),
        start: z.string().min(1).max(40).describe(`Start: ${INSTANT_FORMAT_HINT}.`),
        end: z.string().min(1).max(40).describe(`End: ${INSTANT_FORMAT_HINT}.`),
        location: z.string().max(MAX_TEXT_LENGTH).optional().describe("Where it happens."),
        description: z.string().max(MAX_TEXT_LENGTH).optional().describe("Optional detail."),
      }),
      async execute({ title, start, end, location, description }) {
        const event = await service.create({
          summary: title,
          start: parseInstant(start),
          end: parseInstant(end),
          ...(location !== undefined ? { location } : {}),
          ...(description !== undefined ? { description } : {}),
        });
        return { created: view(event, timeZone) };
      },
    }),

    defineTool({
      name: "update_calendar_event",
      description:
        "Change an event's title, time, location or description. On a recurring event this " +
        "changes only that occurrence, not the whole series; the result says whether it was " +
        "part of one, so say so when it was. Moving an event needs both start and end unless " +
        "the duration is meant to change.",
      schema: z.object({
        event_id: eventIdArg,
        title: z.string().min(1).max(MAX_SUMMARY_LENGTH).optional().describe("New title."),
        start: z.string().min(1).max(40).optional().describe(`New start: ${INSTANT_FORMAT_HINT}.`),
        end: z.string().min(1).max(40).optional().describe(`New end: ${INSTANT_FORMAT_HINT}.`),
        location: z.string().max(MAX_TEXT_LENGTH).optional().describe("New location."),
        description: z.string().max(MAX_TEXT_LENGTH).optional().describe("New description."),
      }),
      async execute({ event_id, title, start, end, location, description }) {
        const event = await service.update(event_id, {
          ...(title !== undefined ? { summary: title } : {}),
          ...(start !== undefined ? { start: parseInstant(start) } : {}),
          ...(end !== undefined ? { end: parseInstant(end) } : {}),
          ...(location !== undefined ? { location } : {}),
          ...(description !== undefined ? { description } : {}),
        });
        return { updated: view(event, timeZone) };
      },
    }),

    defineTool({
      name: "delete_calendar_event",
      // Not recoverable from here, so the registry holds it until the user has
      // been asked in an earlier turn. The summary is what they get shown.
      confirm: ({ event_id }) => `About to permanently delete calendar event ${event_id}.`,
      description:
        "Delete an event from the calendar. This cannot be undone, so confirm with the user " +
        "first, naming the event and its time. On a recurring event only that occurrence goes.",
      schema: z.object({ event_id: eventIdArg }),
      async execute({ event_id }) {
        const event = await service.delete(event_id);
        return { deleted: view(event, timeZone) };
      },
    }),

    defineTool({
      name: "find_free_slots",
      description:
        "Find gaps in the calendar of at least a given length, within a range. " +
        "All-day events do not block a slot, but any overlapping the range come back " +
        "separately: mention them, because one of them may mean the day is gone.",
      schema: z.object({
        from: fromArg,
        to: toArg,
        minimum_minutes: z
          .number()
          .int()
          .min(5)
          .max(24 * 60)
          .describe("Shortest gap worth reporting, in minutes."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(`Maximum slots to return (default ${DEFAULT_SLOT_LIMIT}).`),
      }),
      async execute({ from, to, minimum_minutes, limit }) {
        const { slots, allDay } = await service.findFree({
          from: parseInstant(from),
          to: parseInstant(to),
          minimumMinutes: minimum_minutes,
          limit: limit ?? DEFAULT_SLOT_LIMIT,
        });
        return {
          count: slots.length,
          slots: slots.map((s) => ({
            start: formatInstant(s.start, timeZone),
            end: formatInstant(s.end, timeZone),
            duration: formatDuration((s.end.getTime() - s.start.getTime()) / 1000),
          })),
          ...(allDay.length > 0 ? { all_day_events: allDay.map((e) => view(e, timeZone)) } : {}),
        };
      },
    }),
  ];
}
