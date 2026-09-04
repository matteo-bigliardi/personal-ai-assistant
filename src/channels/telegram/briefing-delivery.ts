import type { Bot } from "grammy";
import type { BriefingDelivery } from "../../jobs/briefing.js";

/**
 * Delivering the morning briefing to Telegram. Transport only: the text was
 * composed before it got here, and no decision is taken in this file.
 */
export function createTelegramBriefingDelivery(bot: Bot): BriefingDelivery {
  return {
    async deliver({ chatId, text }) {
      // Any failure propagates: the job releases the day and lets pg-boss
      // retry, which is the whole reason a failed send must be loud.
      await bot.api.sendMessage(chatId, `☀️ ${text}`);
    },
  };
}
