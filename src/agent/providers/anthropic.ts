import Anthropic from "@anthropic-ai/sdk";
import type { AgentInput, AgentTurnResult, LlmProvider, ToolCall, Turn } from "./types.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
}

function toMessages(turns: Turn[]): Anthropic.MessageParam[] {
  return turns.map((turn): Anthropic.MessageParam => {
    if (turn.role === "user") {
      return { role: "user", content: turn.text };
    }
    if (turn.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (turn.text) blocks.push({ type: "text", text: turn.text });
      for (const call of turn.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input as Record<string, unknown>,
        });
      }
      return { role: "assistant", content: blocks };
    }
    // Anthropic carries tool results in a user-role message.
    return {
      role: "user",
      content: turn.results.map((result): Anthropic.ToolResultBlockParam => ({
        type: "tool_result",
        tool_use_id: result.id,
        content: result.content,
        is_error: result.isError,
      })),
    };
  });
}

/**
 * Anthropic implementation of the LlmProvider boundary: one round trip, no
 * loop, no side effects.
 *
 * The system prompt carries a cache breakpoint. Caching is prefix-based and
 * covers the tool definitions and the system prompt together — the fixed part
 * of every request, and by far its largest part. A single user turn costs
 * two or three round trips, so the cache already pays for itself within one
 * turn: a write at 1.25x followed by reads at 0.1x, instead of full price
 * every time. This is what keeps the running cost inside the monthly budget,
 * and it is also why nothing volatile (such as the current time) may be put in
 * the system prompt.
 */
export function createAnthropicProvider(opts: AnthropicProviderOptions): LlmProvider {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const maxTokens = opts.maxTokens ?? 1024;

  return {
    async run(input: AgentInput): Promise<AgentTurnResult> {
      const start = Date.now();
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: maxTokens,
        system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
        ...(input.tools?.length
          ? {
              tools: input.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
              })),
            }
          : {}),
        messages: toMessages(input.messages),
      });
      const latencyMs = Date.now() - start;

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();

      const toolCalls: ToolCall[] = response.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
        .map((block) => ({ id: block.id, name: block.name, input: block.input }));

      return {
        text,
        toolCalls,
        stopReason: response.stop_reason ?? undefined,
        model: response.model,
        latencyMs,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? undefined,
          cacheReadInputTokens: response.usage.cache_read_input_tokens ?? undefined,
        },
      };
    },
  };
}
