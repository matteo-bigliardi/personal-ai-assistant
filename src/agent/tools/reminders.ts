import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tool-registry.js";
import {
  MAX_DELAY_MINUTES,
  MAX_MESSAGE_LENGTH,
  MIN_DELAY_MINUTES,
  REMINDER_STATUSES,
  type RemindersService,
} from "../../domain/reminders/service.js";
import type { Reminder } from "../../db/schema.js";
import { REF_LENGTH, shortRef } from "../../domain/reference.js";
import { INSTANT_FORMAT_HINT, formatInstant, parseInstant } from "../../domain/datetime.js";

/**
 * Reminder tools.
 *
 * The chat a reminder belongs to is never an argument: it comes from the turn
 * being handled, so the model cannot send one somewhere else, by mistake or
 * otherwise.
 */

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

const refArg = z
  .string()
  .min(1)
  .max(36)
  .describe(`The ${REF_LENGTH}-character reminder id shown in a reminder listing.`);

const minutesArg = z
  .number()
  .int()
  .min(MIN_DELAY_MINUTES)
  .max(MAX_DELAY_MINUTES)
  .describe("A whole number of minutes from now.");

interface ReminderView {
  id: string;
  message: string;
  status: string;
  due_at: string;
  snoozed_times?: number;
}

function view(reminder: Reminder, timeZone: string): ReminderView {
  return {
    id: shortRef(reminder),
    message: reminder.message,
    status: reminder.status,
    due_at: formatInstant(reminder.dueAt, timeZone),
    ...(reminder.snoozeCount > 0 ? { snoozed_times: reminder.snoozeCount } : {}),
  };
}

export function createReminderTools(service: RemindersService, timeZone: string): ToolDefinition[] {
  return [
    defineTool({
      name: "create_reminder",
      description:
        "Schedule a message to be sent back to this chat at a given time. " +
        'For a delay the user expressed as a duration ("in 45 minutes") use in_minutes ' +
        "and let the assistant do the arithmetic; use at only for a stated clock time. " +
        "Give exactly one of the two.",
      schema: z.object({
        message: z
          .string()
          .min(1)
          .max(MAX_MESSAGE_LENGTH)
          .describe("What to say when it fires, phrased as the reminder itself."),
        at: z.string().min(1).max(40).optional().describe(`A stated time: ${INSTANT_FORMAT_HINT}.`),
        in_minutes: minutesArg.optional().describe("A delay from now, in whole minutes."),
      }),
      async execute({ message, at, in_minutes }, { chatId }) {
        const reminder = await service.create({
          chatId,
          message,
          ...(at !== undefined ? { at: parseInstant(at) } : {}),
          ...(in_minutes !== undefined ? { inMinutes: in_minutes } : {}),
        });
        return { created: view(reminder, timeZone) };
      },
    }),

    defineTool({
      name: "list_reminders",
      description:
        "List this chat's reminders, and the way to get the ids the other reminder tools " +
        "need. Returns every status unless one is given.",
      schema: z.object({
        status: z.enum(REMINDER_STATUSES).optional().describe("Filter by exactly this status."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIST_LIMIT)
          .optional()
          .describe(`Maximum reminders to return (default ${DEFAULT_LIST_LIMIT}).`),
      }),
      async execute({ status, limit }, { chatId }) {
        const reminders = await service.list({
          chatId,
          ...(status !== undefined ? { status } : {}),
          limit: limit ?? DEFAULT_LIST_LIMIT,
        });
        return { count: reminders.length, reminders: reminders.map((r) => view(r, timeZone)) };
      },
    }),

    defineTool({
      name: "snooze_reminder",
      description:
        "Postpone a reminder that has already been delivered. " +
        "One that has not fired yet cannot be snoozed; cancel it and make a new one.",
      schema: z.object({ reminder_id: refArg, minutes: minutesArg }),
      async execute({ reminder_id, minutes }) {
        const reminder = await service.snooze(reminder_id, minutes);
        return { snoozed: view(reminder, timeZone) };
      },
    }),

    defineTool({
      name: "cancel_reminder",
      description: "Call off a reminder that has not fired yet.",
      schema: z.object({ reminder_id: refArg }),
      async execute({ reminder_id }) {
        const reminder = await service.cancel(reminder_id);
        return { cancelled: view(reminder, timeZone) };
      },
    }),
  ];
}
