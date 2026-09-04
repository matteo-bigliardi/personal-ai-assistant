import { formatNowBlock } from "../domain/datetime.js";
import { createNoopAuditSink, type AuditSink } from "../observability/audit.js";
import type { Logger } from "../observability/logger.js";
import { createConversationStore, type ConversationStore } from "./history.js";
import type { AgentTurnResult, LlmProvider, Turn } from "./providers/types.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * Stable system prompt.
 *
 * Everything here is constant across requests on purpose: together with the
 * tool definitions it forms the cached prefix of every call. Anything that
 * changes per turn — the current time above all — is prepended to the user
 * message instead.
 */
const SYSTEM_PROMPT = `You are a personal assistant for a single user, reached over Telegram.
You manage projects, tasks, tracked time, reminders and the calendar.

Operating rules:
- Stored state lives in the database, not in this conversation. To answer any
  question about it, call a tool and answer from the result. Never recall or
  invent values you have not just read.
- Every action happens through a tool. If no tool covers a request, say so
  plainly instead of implying it was done.
- Date and time arguments must be absolute ISO-8601 instants with a UTC offset,
  such as 2026-08-29T15:00:00+02:00. Resolve relative wording ("Friday",
  "tomorrow") against the [context] block, which is computed from the real
  clock. Never do calendar arithmetic from memory.
- A tool result containing "error" means the action did NOT happen. Read the
  message, correct the arguments and retry, or explain the problem.
- Answer in the language the user writes in. Keep it short: this is a chat, not
  a report. Plain text, no markdown tables.`;

export interface Agent {
  handleMessage(input: { chatId: string; text: string }): Promise<string>;
}

export interface AgentOptions {
  provider: LlmProvider;
  tools: ToolRegistry;
  logger: Logger;
  timeZone: string;
  conversations?: ConversationStore;
  audit?: AuditSink;
  /** Upper bound on provider round trips per user message. */
  maxIterations?: number;
  now?: () => Date;
}

interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
}

function accumulate(totals: Totals, result: AgentTurnResult): void {
  totals.inputTokens += result.usage?.inputTokens ?? 0;
  totals.outputTokens += result.usage?.outputTokens ?? 0;
  totals.cacheReadTokens += result.usage?.cacheReadInputTokens ?? 0;
  totals.cacheWriteTokens += result.usage?.cacheCreationInputTokens ?? 0;
  totals.latencyMs += result.latencyMs;
}

/**
 * The agent loop.
 *
 * message -> provider -> validate and execute tool calls -> feed results back
 * -> final answer. The provider only ever reports what the model wants; the
 * loop, the validation and every side effect stay here, outside the LLM. The
 * number of round trips is bounded so a model that keeps calling tools cannot
 * burn the budget.
 */
export function createAgent(opts: AgentOptions): Agent {
  const { provider, tools, logger, timeZone } = opts;
  const conversations = opts.conversations ?? createConversationStore();
  const audit = opts.audit ?? createNoopAuditSink();
  const maxIterations = opts.maxIterations ?? 5;
  const clock = opts.now ?? (() => new Date());

  return {
    async handleMessage({ chatId, text }): Promise<string> {
      const startedAt = Date.now();
      const context = formatNowBlock(clock(), timeZone);
      const messages: Turn[] = [
        ...conversations.get(chatId),
        { role: "user", text: `${context}\n\n${text}` },
      ];

      const totals: Totals = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: 0,
      };

      let answer = "";
      let iterations = 0;
      let exhausted = true;
      let model: string | undefined;

      for (let i = 0; i < maxIterations; i++) {
        iterations = i + 1;
        const result = await provider.run({
          system: SYSTEM_PROMPT,
          messages,
          tools: tools.specs,
        });
        accumulate(totals, result);
        model = result.model ?? model;

        if (result.text) answer = result.text;

        if (result.toolCalls.length === 0) {
          exhausted = false;
          break;
        }

        messages.push({
          role: "assistant",
          ...(result.text ? { text: result.text } : {}),
          toolCalls: result.toolCalls,
        });

        // Independent calls in one response are executed together; each one
        // validates its own arguments and reports its own failure.
        const results = await Promise.all(
          result.toolCalls.map((call) => tools.execute(call, { chatId })),
        );
        messages.push({ role: "tool", results });
      }

      if (exhausted) {
        logger.warn("agent.iteration_limit", { chatId, maxIterations });
        answer =
          answer ||
          "I could not finish that within my step limit. Try splitting the request into smaller ones.";
      }

      logger.info("agent.turn", {
        chatId,
        iterations,
        ...totals,
      });

      // The audited latency is wall clock, not the sum of the provider calls:
      // it is what the user actually waited for, tool execution included, which
      // is the number the system latency percentiles are supposed to describe.
      await audit.agentTurn({
        status: exhausted ? "error" : "ok",
        ...(exhausted ? { errorCode: "iteration_limit" } : {}),
        iterations,
        latencyMs: Date.now() - startedAt,
        model,
        tokens: {
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          cacheWriteTokens: totals.cacheWriteTokens,
          providerLatencyMs: totals.latencyMs,
        },
      });

      const reply = answer || "…";
      conversations.append(chatId, text, reply);
      return reply;
    },
  };
}
