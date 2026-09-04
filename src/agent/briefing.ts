import { renderBriefing, type BriefingData } from "../domain/briefing/service.js";
import type { Logger } from "../observability/logger.js";
import type { LlmProvider } from "./providers/types.js";

/**
 * Turning the collected briefing data into a few readable lines.
 *
 * This is the one place in the project where the model is used without tools
 * and without a loop: exactly one round trip, on data that has already been
 * gathered deterministically. The provider needs nothing new for it — an empty
 * tool list is simply not sent — and the model is given no way to go looking
 * for anything it was not handed.
 *
 * If the call fails the briefing still goes out, written from the same data by
 * `renderBriefing`. A morning message that is a little flat beats no message,
 * and a silent morning is indistinguishable from a job that never ran.
 */

/**
 * Italian, because there is no incoming message whose language to match and the
 * assistant has exactly one user. The fallback text is written the same way.
 */
const BRIEFING_SYSTEM = `You write one short morning briefing for a single person, in Italian.

You are given a JSON object with today's calendar events and the tasks that are
due or overdue. Rules:
- Use only what is in the JSON. Never invent an event, a task, a time or a name.
- Keep it under six short lines. Plain text, no markdown, no tables, no preamble.
- Times are already local; print them as they are.
- If there is nothing at all, say so plainly and explicitly — that is a useful
  message, not an empty one. Do not apologise for it and do not pad it.
- If the calendar could not be read, say that the calendar is unavailable rather
  than implying the day is free.`;

export interface BriefingWriter {
  write(data: BriefingData): Promise<string>;
}

export interface BriefingWriterOptions {
  provider: LlmProvider;
  logger: Logger;
}

export function createBriefingWriter(opts: BriefingWriterOptions): BriefingWriter {
  const { provider, logger } = opts;

  return {
    async write(data) {
      try {
        const result = await provider.run({
          system: BRIEFING_SYSTEM,
          messages: [{ role: "user", text: JSON.stringify(data) }],
          tools: [],
        });

        const text = result.text.trim();
        if (!text) {
          logger.warn("briefing.empty_completion");
          return renderBriefing(data);
        }

        logger.info("briefing.written", {
          model: result.model,
          latencyMs: result.latencyMs,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
        });
        return text;
      } catch (err) {
        logger.error("briefing.write_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return renderBriefing(data);
      }
    },
  };
}
