import { Bot } from "grammy";
import type { Agent } from "../../agent/agent.js";
import type { Logger } from "../../observability/logger.js";
import { parseReminderCallback } from "./reminder-delivery.js";

export interface TelegramBotOptions {
  token: string;
  /** Numeric Telegram user IDs allowed to interact with the bot. */
  allowedUserIds: number[];
  agent: Agent;
  logger: Logger;
  /**
   * Handles the buttons attached to a delivered reminder. Kept as a narrow
   * callback rather than the whole service, so the transport still knows
   * nothing about the domain.
   */
  onSnooze?: (reminderId: string, minutes: number) => Promise<void>;
}

/**
 * Telegram transport (grammY, long polling in V1). This layer only handles
 * transport, the allowlist and delegating to the agent. No domain logic here.
 */
export function createTelegramBot(opts: TelegramBotOptions): Bot {
  const { token, allowedUserIds, agent, logger, onSnooze } = opts;
  const bot = new Bot(token);
  const allowed = new Set(allowedUserIds);

  // Allowlist guard: reject any user not explicitly permitted, and answer only
  // in private chats. Anyone can add a bot to a group without the owner's
  // consent; without the chat-type check an allowlisted user writing in a group
  // would have the assistant post their agenda and tasks to everyone there.
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    const chatType = ctx.chat?.type;

    if (chatType !== undefined && chatType !== "private") {
      logger.warn("telegram.rejected_non_private_chat", { chatType, userId });
      return;
    }
    if (userId === undefined || !allowed.has(userId)) {
      logger.warn("telegram.unauthorized", { userId });
      if (ctx.chat) await ctx.reply("Not authorized.");
      return;
    }
    await next();
  });

  bot.command("start", (ctx) => ctx.reply("Assistant online. How can I help?"));

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    try {
      await ctx.replyWithChatAction("typing");
      // The chat id scopes the short conversational memory; in a single-user
      // deployment there is exactly one, but the agent must not assume that.
      const reply = await agent.handleMessage({ chatId: String(ctx.chat.id), text });
      await ctx.reply(reply);
    } catch (err) {
      logger.error("telegram.handler_error", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.reply("Something went wrong handling that message.");
    }
  });

  // Buttons on a delivered reminder. The allowlist middleware above has
  // already run, so an unauthorised press never reaches here.
  bot.on("callback_query:data", async (ctx) => {
    const action = parseReminderCallback(ctx.callbackQuery.data);
    if (!action) {
      await ctx.answerCallbackQuery();
      return;
    }

    try {
      if (action.kind === "done") {
        await ctx.answerCallbackQuery("Done");
      } else if (onSnooze) {
        await onSnooze(action.reminderId, action.minutes);
        await ctx.answerCallbackQuery(`Snoozed ${action.minutes}m`);
      } else {
        await ctx.answerCallbackQuery("Snoozing is not available.");
        return;
      }
      // Drop the buttons so the same reminder cannot be actioned twice from
      // an old message still sitting in the chat history.
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch (err) {
      logger.error("telegram.callback_error", {
        kind: action.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.answerCallbackQuery("That did not work.");
    }
  });

  bot.catch((err) => {
    logger.error("telegram.bot_error", {
      error: err.error instanceof Error ? err.error.message : String(err.error),
    });
  });

  return bot;
}
