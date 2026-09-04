import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAuditRepository, type AuditRepository } from "../../src/db/repositories/audit.js";
import { setupTestDb } from "./helpers/db.js";

/**
 * Against a real Postgres because what is being checked lives there: the enums
 * accept exactly the two event kinds, jsonb round-trips the argument shapes,
 * and a delete by cutoff is what keeps the table bounded.
 */
const testDb = await setupTestDb();
const describeDb = testDb ? describe : describe.skip;

if (!testDb) {
  console.warn("[integration] no Postgres reachable — skipping audit repository tests");
}

const at = (iso: string) => new Date(iso);

describeDb("audit repository", () => {
  let repo: AuditRepository;

  beforeEach(async () => {
    await testDb?.truncate();
    if (testDb) repo = createAuditRepository(testDb.db);
  });

  afterAll(async () => {
    await testDb?.close();
  });

  it("stores a tool call with its argument shape and outcome", async () => {
    await repo.record({
      timestamp: at("2026-09-04T10:00:00Z"),
      eventType: "tool_call",
      tool: "create_task",
      arguments: { title: "string(16)", dueAt: "string(25)" },
      status: "ok",
      latencyMs: 14,
    });

    const [row] = await repo.list({ limit: 10 });

    expect(row).toMatchObject({
      eventType: "tool_call",
      tool: "create_task",
      arguments: { title: "string(16)", dueAt: "string(25)" },
      status: "ok",
      latencyMs: 14,
    });
    expect(row?.timestamp.toISOString()).toBe("2026-09-04T10:00:00.000Z");
    // Turn-only columns stay empty on a tool call.
    expect(row?.model).toBeNull();
    expect(row?.iterations).toBeNull();
  });

  it("stores a turn with its model, round trips and token counters", async () => {
    await repo.record({
      timestamp: at("2026-09-04T10:00:01Z"),
      eventType: "agent_turn",
      status: "error",
      errorCode: "iteration_limit",
      latencyMs: 9000,
      model: "claude-sonnet-5",
      iterations: 5,
      tokenCostMetadata: { inputTokens: 120, cacheReadTokens: 12646 },
    });

    const [row] = await repo.list({ eventType: "agent_turn", limit: 10 });

    expect(row).toMatchObject({
      status: "error",
      errorCode: "iteration_limit",
      model: "claude-sonnet-5",
      iterations: 5,
      tokenCostMetadata: { inputTokens: 120, cacheReadTokens: 12646 },
    });
    expect(row?.tool).toBeNull();
  });

  it("lists the most recent first, and filters by kind and tool", async () => {
    await repo.record({
      timestamp: at("2026-09-04T09:00:00Z"),
      eventType: "tool_call",
      tool: "list_tasks",
      status: "ok",
    });
    await repo.record({
      timestamp: at("2026-09-04T11:00:00Z"),
      eventType: "tool_call",
      tool: "create_task",
      status: "ok",
    });
    await repo.record({
      timestamp: at("2026-09-04T10:00:00Z"),
      eventType: "agent_turn",
      status: "ok",
    });

    expect((await repo.list({ limit: 10 })).map((r) => r.eventType)).toEqual([
      "tool_call",
      "agent_turn",
      "tool_call",
    ]);
    expect(await repo.list({ tool: "list_tasks", limit: 10 })).toHaveLength(1);
    expect(await repo.list({ eventType: "agent_turn", limit: 10 })).toHaveLength(1);
    expect(await repo.list({ limit: 2 })).toHaveLength(2);
  });

  it("drops only what is older than the cutoff", async () => {
    for (const iso of ["2026-06-01T00:00:00Z", "2026-06-05T00:00:00Z", "2026-09-01T00:00:00Z"]) {
      await repo.record({ timestamp: at(iso), eventType: "tool_call", status: "ok" });
    }

    const deleted = await repo.deleteOlderThan(at("2026-06-06T00:00:00Z"));

    expect(deleted).toBe(2);
    const remaining = await repo.list({ limit: 10 });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.timestamp.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});
