/**
 * Replaceable LLM provider boundary. V1 ships a single cloud provider
 * (Anthropic), but nothing outside this folder may depend on a concrete SDK.
 * Future ML backends (local quantized, custom Transformer, router) implement
 * this same interface.
 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentInput {
  /** System prompt / persona and operating rules. */
  system: string;
  /** Conversation so far (minimal context by default). */
  messages: ChatMessage[];
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentTurnResult {
  /** Final text to send back to the user. */
  text: string;
  usage?: TokenUsage;
  model?: string;
  /** Wall-clock latency of the provider call, in milliseconds. */
  latencyMs: number;
}

export interface LlmProvider {
  run(input: AgentInput): Promise<AgentTurnResult>;
}
