import { InlineKeyboard, type Bot } from "grammy";
import type { ReminderDelivery } from "../../jobs/reminders.js";

/**
 * Delivering a reminder to Telegram.
 *
 * Transport only: the text was composed when the reminder was created, and no
 * model is consulted here. That is what lets a reminder arrive on time while
 * the LLM is unreachable.
 */

/** Prefix that marks a callback as ours, so other buttons can coexist later. */
const CALLBACK_PREFIX = "rem";

export const SNOOZE_CHOICES = [
  { label: "Snooze 10m", minutes: 10 },
  { label: "Snooze 1h", minutes: 60 },
] as const;

export function reminderKeyboard(reminderId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("Done", `${CALLBACK_PREFIX}:done:${reminderId}`);
  for (const choice of SNOOZE_CHOICES) {
    keyboard.text(choice.label, `${CALLBACK_PREFIX}:snooze:${reminderId}:${choice.minutes}`);
  }
  return keyboard;
}

export type ReminderAction =
  { kind: "done"; reminderId: string } | { kind: "snooze"; reminderId: string; minutes: number };

/**
 * Parses one of our callbacks, or returns undefined for anything else.
 * Callback data comes back from Telegram, so it is treated as input to be
 * validated rather than as something we wrote and can trust.
 */
export function parseReminderCallback(data: string): ReminderAction | undefined {
  const parts = data.split(":");
  if (parts[0] !== CALLBACK_PREFIX) return undefined;

  const [, kind, reminderId, rawMinutes] = parts;
  if (!reminderId) return undefined;

  if (kind === "done") return { kind: "done", reminderId };
  if (kind === "snooze") {
    const minutes = Number(rawMinutes);
    if (!Number.isInteger(minutes) || minutes <= 0) return undefined;
    return { kind: "snooze", reminderId, minutes };
  }
  return undefined;
}

export function createTelegramReminderDelivery(bot: Bot): ReminderDelivery {
  return {
    async deliver({ chatId, reminderId, message }) {
      // Any failure propagates so pg-boss retries: a reminder that silently
      // failed to send is the one failure mode worth being noisy about.
      await bot.api.sendMessage(chatId, `⏰ ${message}`, {
        reply_markup: reminderKeyboard(reminderId),
      });
    },
  };
}
