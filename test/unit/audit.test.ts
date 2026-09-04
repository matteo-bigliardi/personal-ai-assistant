import { describe, expect, it } from "vitest";
import type { AuditRepository, RecordAuditEventInput } from "../../src/db/repositories/audit.js";
import { createAuditSink, describeArguments } from "../../src/observability/audit.js";
import { createTestLogger } from "../helpers/logger.js";

const NOW = new Date("2026-09-04T10:00:00Z");

function fakeRepo(fail = false) {
  const recorded: RecordAuditEventInput[] = [];
  const repo: AuditRepository = {
    async record(input) {
      if (fail) throw new Error("connection to postgres://user:hunter2@host refused");
      recorded.push(input);
    },
    async list() {
      return [];
    },
    async deleteOlderThan() {
      return 0;
    },
  };
  return { repo, recorded };
}

describe("describeArguments", () => {
  it("keeps the argument names and drops every value", () => {
    const described = describeArguments({
      title: "prepare the demo",
      dueAt: "2026-09-11T17:00:00+02:00",
      priority: null,
      done: false,
      tags: ["a", "b", "c"],
      window: { from: 1, to: 2 },
    });

    expect(described).toEqual({
      title: "string(16)",
      dueAt: "string(25)",
      priority: "null",
      done: "boolean",
      tags: "array[3]",
      window: "object{2}",
    });
    // The point of the whole exercise: nothing the user said survives.
    expect(JSON.stringify(described)).not.toContain("demo");
  });

  it("records a malformed call rather than dropping it", () => {
    // A model that sends a bare string instead of an object is precisely what
    // the argument-correctness metric is meant to catch.
    expect(describeArguments("just a string")).toEqual({ "(root)": "string(13)" });
    expect(describeArguments(null)).toEqual({ "(root)": "null" });
  });
});

describe("audit sink", () => {
  it("records a tool call by shape, with its outcome and latency", async () => {
    const { repo, recorded } = fakeRepo();
    const sink = createAuditSink({ repo, logger: createTestLogger(), now: () => NOW });

    await sink.toolCall({
      tool: "create_task",
      input: { title: "prepare the demo" },
      status: "error",
      errorCode: "not_found",
      latencyMs: 12,
    });

    expect(recorded).toEqual([
      {
        timestamp: NOW,
        eventType: "tool_call",
        tool: "create_task",
        arguments: { title: "string(16)" },
        status: "error",
        errorCode: "not_found",
        latencyMs: 12,
      },
    ]);
  });

  it("records a turn with its model, round trips and token counters", async () => {
    const { repo, recorded } = fakeRepo();
    const sink = createAuditSink({ repo, logger: createTestLogger(), now: () => NOW });

    await sink.agentTurn({
      status: "ok",
      iterations: 2,
      latencyMs: 3400,
      model: "claude-sonnet-5",
      tokens: { inputTokens: 120, cacheReadTokens: 12646 },
    });

    expect(recorded[0]).toMatchObject({
      eventType: "agent_turn",
      status: "ok",
      iterations: 2,
      model: "claude-sonnet-5",
      tokenCostMetadata: { inputTokens: 120, cacheReadTokens: 12646 },
    });
  });

  it("swallows a failed write, because the action already happened", async () => {
    const { repo } = fakeRepo(true);
    const logger = createTestLogger();
    const sink = createAuditSink({ repo, logger, now: () => NOW });

    await expect(
      sink.toolCall({ tool: "create_task", input: {}, status: "ok", latencyMs: 1 }),
    ).resolves.toBeUndefined();

    const failure = logger.find("audit.write_failed");
    expect(failure?.meta).toMatchObject({ event: "tool_call" });
  });
});
