/**
 * Replaceable LLM provider boundary. V1 ships a single cloud provider
 * (Anthropic), but nothing outside this folder may depend on a concrete SDK.
 * Future backends (local quantized model, custom Transformer, cloud/local
 * router) implement this same interface.
 *
 * The provider performs exactly ONE round trip. It never executes a tool and
 * never loops: it reports what the model asked for and returns. The agent owns
 * the loop, the validation and every side effect. That keeps a future local
 * backend from having to re-implement the orchestration, and keeps the rule
 * "all side effects outside the LLM" true by construction.
 */

/** A tool as advertised to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12) for the tool arguments. */
  inputSchema: Record<string, unknown>;
}

/** A tool invocation requested by the model. Arguments are still unvalidated. */
export interface ToolCall {
  /** Provider-assigned id, used to correlate the result. */
  id: string;
  name: string;
  input: unknown;
}

/** The outcome of a tool invocation, fed back to the model. */
export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

/**
 * Provider-neutral conversation item. Concrete providers map these onto their
 * own wire format (Anthropic, for instance, carries tool results inside a user
 * message; another backend may not).
 */
export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export interface AgentInput {
  /** Stable system prompt. Kept constant so providers can cache the prefix. */
  system: string;
  messages: Turn[];
  tools?: ToolSpec[];
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens written to the prompt cache, billed at a premium. */
  cacheCreationInputTokens?: number;
  /** Tokens served from the prompt cache, billed at a fraction of the price. */
  cacheReadInputTokens?: number;
}

export interface AgentTurnResult {
  /** Text produced in this round trip. Empty when the model only called tools. */
  text: string;
  /** Empty when the model produced a final answer. */
  toolCalls: ToolCall[];
  stopReason?: string;
  usage?: TokenUsage;
  model?: string;
  /** Wall-clock latency of the provider call, in milliseconds. */
  latencyMs: number;
}

export interface LlmProvider {
  run(input: AgentInput): Promise<AgentTurnResult>;
}
