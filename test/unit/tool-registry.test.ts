import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createToolRegistry, defineTool } from "../../src/agent/tool-registry.js";
import { ConflictError } from "../../src/domain/errors.js";
import { createAuditSink } from "../../src/observability/audit.js";
import { createRecordingAuditSink } from "../helpers/audit.js";
import { createTestLogger } from "../helpers/logger.js";

const echo = defineTool({
  name: "echo",
  description: "Echo a message back.",
  schema: z.object({ message: z.string().min(1), times: z.number().int().min(1).optional() }),
  async execute({ message, times }) {
    return { message, times: times ?? 1 };
  },
});

function parse(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

const CONTEXT = { chatId: "chat-1", turnId: "turn-1" };

describe("createToolRegistry", () => {
  it("advertises each tool as a JSON Schema object", () => {
    const registry = createToolRegistry([echo], createTestLogger());
    const [spec] = registry.specs;

    expect(spec?.name).toBe("echo");
    expect(spec?.inputSchema).toMatchObject({ type: "object" });
    expect(spec?.inputSchema).not.toHaveProperty("$schema");
    const properties = spec?.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(["message", "times"]);
    // Optional arguments must not be advertised as required.
    expect(spec?.inputSchema.required).toEqual(["message"]);
  });

  it("rejects duplicate tool names at construction", () => {
    expect(() => createToolRegistry([echo, echo], createTestLogger())).toThrow(/Duplicate tool/);
  });

  it("executes a valid call and returns structured output", async () => {
    const logger = createTestLogger();
    const registry = createToolRegistry([echo], logger);

    const result = await registry.execute(
      { id: "t1", name: "echo", input: { message: "hi" } },
      CONTEXT,
    );

    expect(result.isError).toBeUndefined();
    expect(parse(result.content)).toEqual({ message: "hi", times: 1 });
    expect(logger.find("tool.call")?.meta).toMatchObject({ tool: "echo", ok: true });
  });

  it("turns invalid arguments into a readable error instead of throwing", async () => {
    const registry = createToolRegistry([echo], createTestLogger());

    const result = await registry.execute(
      { id: "t1", name: "echo", input: { message: 42 } },
      CONTEXT,
    );

    expect(result.isError).toBe(true);
    expect(parse(result.content)).toMatchObject({ error: { code: "invalid_input" } });
    expect(result.content).toContain("message");
  });

  it("reports an unknown tool without failing the turn", async () => {
    const registry = createToolRegistry([echo], createTestLogger());

    const result = await registry.execute({ id: "t1", name: "nope", input: {} }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(parse(result.content)).toMatchObject({ error: { code: "unknown_tool" } });
  });

  it("passes a domain error through so the model can correct itself", async () => {
    const failing = defineTool({
      name: "boom",
      description: "Always conflicts.",
      schema: z.object({}),
      async execute() {
        throw new ConflictError('A project named "Atlas" already exists.');
      },
    });
    const registry = createToolRegistry([failing], createTestLogger());

    const result = await registry.execute({ id: "t1", name: "boom", input: {} }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(parse(result.content)).toEqual({
      error: { code: "conflict", message: 'A project named "Atlas" already exists.' },
    });
  });

  it("hides unexpected failures from the model but logs them", async () => {
    const failing = defineTool({
      name: "boom",
      description: "Always breaks.",
      schema: z.object({}),
      async execute() {
        throw new Error("connection string postgres://user:hunter2@host/db refused");
      },
    });
    const logger = createTestLogger();
    const registry = createToolRegistry([failing], logger);

    const result = await registry.execute({ id: "t1", name: "boom", input: {} }, CONTEXT);

    expect(parse(result.content)).toMatchObject({ error: { code: "internal_error" } });
    expect(result.content).not.toContain("hunter2");
    expect(logger.find("tool.failed")).toBeDefined();
  });

  it("truncates oversized results to keep the context bounded", async () => {
    const huge = defineTool({
      name: "huge",
      description: "Returns too much.",
      schema: z.object({}),
      async execute() {
        return { rows: Array.from({ length: 5000 }, (_, i) => `row-${i}`) };
      },
    });
    const registry = createToolRegistry([huge], createTestLogger());

    const result = await registry.execute({ id: "t1", name: "huge", input: {} }, CONTEXT);

    expect(result.content.length).toBeLessThan(8_100);
    expect(result.content).toContain("truncated");
  });
});

describe("tool registry audit", () => {
  it("records every call, successful or not, by argument shape", async () => {
    const audit = createRecordingAuditSink();
    const registry = createToolRegistry([echo], createTestLogger(), { audit });

    await registry.execute({ id: "t1", name: "echo", input: { message: "hi" } }, CONTEXT);
    await registry.execute({ id: "t2", name: "echo", input: { message: 42 } }, CONTEXT);
    await registry.execute({ id: "t3", name: "nope", input: {} }, CONTEXT);

    expect(audit.toolCalls.map((c) => [c.tool, c.status, c.errorCode])).toEqual([
      ["echo", "ok", undefined],
      ["echo", "error", "invalid_input"],
      ["nope", "error", "unknown_tool"],
    ]);
    // The raw input reaches the sink; turning it into a shape is the sink's job.
    expect(audit.toolCalls[0]?.input).toEqual({ message: "hi" });
    expect(audit.toolCalls[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records the domain code a failing tool returned", async () => {
    const audit = createRecordingAuditSink();
    const failing = defineTool({
      name: "boom",
      description: "Always conflicts.",
      schema: z.object({}),
      async execute() {
        throw new ConflictError("already exists");
      },
    });
    const registry = createToolRegistry([failing], createTestLogger(), { audit });

    await registry.execute({ id: "t1", name: "boom", input: {} }, CONTEXT);

    expect(audit.toolCalls[0]).toMatchObject({ status: "error", errorCode: "conflict" });
  });

  it("returns the tool result even when the audit write fails", async () => {
    // Auditing must never break the thing it audits: the tool already ran.
    const logger = createTestLogger();
    const audit = createAuditSink({
      repo: {
        async record() {
          throw new Error("audit_events is gone");
        },
        async list() {
          return [];
        },
        async deleteOlderThan() {
          return 0;
        },
      },
      logger,
    });
    const registry = createToolRegistry([echo], logger, { audit });

    const result = await registry.execute(
      { id: "t1", name: "echo", input: { message: "hi" } },
      CONTEXT,
    );

    expect(parse(result.content)).toEqual({ message: "hi", times: 1 });
    expect(logger.find("audit.write_failed")).toBeDefined();
  });
});
