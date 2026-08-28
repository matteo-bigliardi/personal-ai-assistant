import Anthropic from "@anthropic-ai/sdk";
import type { AgentInput, AgentTurnResult, LlmProvider } from "./types.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
}

/**
 * Anthropic implementation of the LlmProvider boundary.
 * Currently a plain text turn with no tool use; tool support is added later
 * without changing the public interface.
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
        system: input.system,
        messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      const latencyMs = Date.now() - start;

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();

      return {
        text,
        model: response.model,
        latencyMs,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },
  };
}
