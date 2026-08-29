import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgent } from "../../src/agent/agent.js";
import { createToolRegistry, defineTool } from "../../src/agent/tool-registry.js";
import type { AgentInput, AgentTurnResult, LlmProvider } from "../../src/agent/providers/types.js";
import { createTestLogger } from "../helpers/logger.js";

const NOW = new Date("2026-08-29T12:37:00Z");

/** Replays canned provider responses and records what it was asked. */
function fakeProvider(responses: Partial<AgentTurnResult>[]): LlmProvider & {
  calls: AgentInput[];
} {
  const calls: AgentInput[] = [];
  let index = 0;
  return {
    calls,
    async run(input) {
      calls.push(structuredClone(input));
      const canned = responses[Math.min(index, responses.length - 1)] ?? {};
      index++;
      return { text: "", toolCalls: [], latencyMs: 1, ...canned };
    },
  };
}

function registry(executed: string[] = []) {
  const tool = defineTool({
    name: "create_project",
    description: "Create a project.",
    schema: z.object({ name: z.string() }),
    async execute({ name }) {
      executed.push(name);
      return { created: { name } };
    },
  });
  return createToolRegistry([tool], createTestLogger());
}

function agentWith(provider: LlmProvider, overrides = {}) {
  return createAgent({
    provider,
    tools: registry(),
    logger: createTestLogger(),
    timeZone: "Europe/Rome",
    now: () => NOW,
    ...overrides,
  });
}

describe("agent loop", () => {
  it("returns the model's answer when no tool is called", async () => {
    const provider = fakeProvider([{ text: "Nothing to do." }]);

    const reply = await agentWith(provider).handleMessage({ chatId: "1", text: "hello" });

    expect(reply).toBe("Nothing to do.");
    expect(provider.calls).toHaveLength(1);
  });

  it("prepends the computed time context to the user message", async () => {
    const provider = fakeProvider([{ text: "ok" }]);

    await agentWith(provider).handleMessage({ chatId: "1", text: "what day is it?" });

    const first = provider.calls[0]?.messages[0];
    expect(first?.role).toBe("user");
    const text = first && "text" in first ? first.text : "";
    expect(text).toContain("2026-08-29T14:37:00+02:00");
    expect(text).toContain("today Sat 2026-08-29");
    expect(text).toContain("what day is it?");
  });

  it("advertises the registered tools to the provider", async () => {
    const provider = fakeProvider([{ text: "ok" }]);

    await agentWith(provider).handleMessage({ chatId: "1", text: "hi" });

    expect(provider.calls[0]?.tools?.map((t) => t.name)).toEqual(["create_project"]);
  });

  it("executes a tool call and feeds the result back for a final answer", async () => {
    const executed: string[] = [];
    const provider = fakeProvider([
      { toolCalls: [{ id: "c1", name: "create_project", input: { name: "Atlas" } }] },
      { text: "Created Atlas." },
    ]);
    const agent = createAgent({
      provider,
      tools: registry(executed),
      logger: createTestLogger(),
      timeZone: "Europe/Rome",
      now: () => NOW,
    });

    const reply = await agent.handleMessage({ chatId: "1", text: "create Atlas" });

    expect(reply).toBe("Created Atlas.");
    expect(executed).toEqual(["Atlas"]);

    // Second round trip carries the assistant's tool call and its result.
    const second = provider.calls[1]?.messages ?? [];
    expect(second[1]).toMatchObject({ role: "assistant", toolCalls: [{ id: "c1" }] });
    expect(second[2]).toMatchObject({ role: "tool", results: [{ id: "c1" }] });
  });

  it("executes several tool calls from one response", async () => {
    const executed: string[] = [];
    const provider = fakeProvider([
      {
        toolCalls: [
          { id: "c1", name: "create_project", input: { name: "Atlas" } },
          { id: "c2", name: "create_project", input: { name: "Borealis" } },
        ],
      },
      { text: "Both created." },
    ]);
    const agent = createAgent({
      provider,
      tools: registry(executed),
      logger: createTestLogger(),
      timeZone: "Europe/Rome",
      now: () => NOW,
    });

    await agent.handleMessage({ chatId: "1", text: "create two projects" });

    expect(executed).toEqual(["Atlas", "Borealis"]);
  });

  it("stops after the iteration limit instead of looping forever", async () => {
    const logger = createTestLogger();
    // A model that never stops asking for tools.
    const provider = fakeProvider([
      { toolCalls: [{ id: "c1", name: "create_project", input: { name: "Atlas" } }] },
    ]);
    const agent = createAgent({
      provider,
      tools: registry(),
      logger,
      timeZone: "Europe/Rome",
      now: () => NOW,
      maxIterations: 3,
    });

    const reply = await agent.handleMessage({ chatId: "1", text: "go" });

    expect(provider.calls).toHaveLength(3);
    expect(reply).toContain("step limit");
    expect(logger.find("agent.iteration_limit")).toBeDefined();
  });

  it("carries earlier exchanges into the next message, without tool traffic", async () => {
    const provider = fakeProvider([
      { toolCalls: [{ id: "c1", name: "create_project", input: { name: "Atlas" } }] },
      { text: "Created Atlas." },
      { text: "It is active." },
    ]);
    const agent = agentWith(provider);

    await agent.handleMessage({ chatId: "1", text: "create Atlas" });
    await agent.handleMessage({ chatId: "1", text: "what is its status?" });

    const messages = provider.calls[2]?.messages ?? [];
    // Only the completed exchange survives: no tool_use, no tool_result.
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: "user", text: "create Atlas" });
    expect(messages[1]).toEqual({ role: "assistant", text: "Created Atlas." });
    expect(messages.some((m) => m.role === "tool")).toBe(false);
  });

  it("stores the raw user message in history, not the injected context", async () => {
    const provider = fakeProvider([{ text: "ok" }]);
    const agent = agentWith(provider);

    await agent.handleMessage({ chatId: "1", text: "hello" });
    await agent.handleMessage({ chatId: "1", text: "again" });

    expect(provider.calls[1]?.messages[0]).toEqual({ role: "user", text: "hello" });
  });

  it("logs token usage for the whole turn", async () => {
    const logger = createTestLogger();
    const provider = fakeProvider([
      {
        toolCalls: [{ id: "c1", name: "create_project", input: { name: "Atlas" } }],
        usage: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 2000 },
      },
      { text: "done", usage: { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 2000 } },
    ]);
    const agent = agentWith(provider, { logger });

    await agent.handleMessage({ chatId: "1", text: "create Atlas" });

    expect(logger.find("agent.turn")?.meta).toMatchObject({
      iterations: 2,
      inputTokens: 120,
      outputTokens: 15,
      cacheWriteTokens: 2000,
      cacheReadTokens: 2000,
    });
  });
});
