import type { Logger } from "../observability/logger.js";
import type { ChatMessage, LlmProvider } from "./providers/types.js";

const SYSTEM_PROMPT = `You are a personal assistant operating over Telegram for a single user.
You help manage projects, tasks, time tracking, reminders and the calendar.
Be concise and practical. Reply in the same language the user writes in.

In this version you can only converse; tools for projects, tasks, time,
reminders and calendar will be connected in later iterations. Do not claim you
performed an action you cannot yet perform.`;

export interface Agent {
  handleMessage(text: string): Promise<string>;
}

/**
 * Agent loop: currently a single conversational turn, with no tools wired up.
 * The typed-tool loop with bounded iterations lands next. All side effects stay
 * outside the LLM.
 */
export function createAgent(provider: LlmProvider, logger: Logger): Agent {
  return {
    async handleMessage(text: string): Promise<string> {
      const messages: ChatMessage[] = [{ role: "user", content: text }];
      const result = await provider.run({ system: SYSTEM_PROMPT, messages });
      logger.info("agent.turn", {
        model: result.model,
        latencyMs: result.latencyMs,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
      });
      return result.text || "…";
    },
  };
}
