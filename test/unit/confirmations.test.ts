import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createConfirmationStore,
  fingerprintOf,
  type ConfirmationStore,
} from "../../src/agent/confirmations.js";
import { createToolRegistry, defineTool } from "../../src/agent/tool-registry.js";
import { createTestLogger } from "../helpers/logger.js";

const deleted: string[] = [];

const deleteEvent = defineTool({
  name: "delete_calendar_event",
  description: "Delete an event.",
  schema: z.object({ event_id: z.string().min(1) }),
  confirm: ({ event_id }) => `About to permanently delete calendar event ${event_id}.`,
  async execute({ event_id }) {
    deleted.push(event_id);
    return { deleted: event_id };
  },
});

const archiveProject = defineTool({
  name: "update_project",
  description: "Update a project.",
  schema: z.object({ name: z.string(), status: z.enum(["active", "archived"]).optional() }),
  confirm: ({ name, status }) =>
    status === "archived" ? `About to archive "${name}".` : undefined,
  async execute({ name }) {
    return { updated: name };
  },
});

function parse(content: string): { error?: { code?: string; message?: string } } {
  return JSON.parse(content) as { error?: { code?: string; message?: string } };
}

function registryWith(store?: ConfirmationStore) {
  return createToolRegistry([deleteEvent, archiveProject], createTestLogger(), {
    ...(store ? { confirmations: store } : {}),
  });
}

const TURN_1 = { chatId: "chat-1", turnId: "turn-1" };
const TURN_2 = { chatId: "chat-1", turnId: "turn-2" };

const call = (id: string, name: string, input: unknown) => ({ id, name, input });

describe("confirmation store", () => {
  const base = { tool: "t", fingerprint: "f" };

  it("refuses a request answered inside the turn that made it", () => {
    const store = createConfirmationStore();
    store.request({ ...TURN_1, ...base });

    expect(store.redeem({ ...TURN_1, ...base })).toEqual({ ok: false, reason: "same_turn" });
    expect(store.redeem({ ...TURN_2, ...base })).toEqual({ ok: true });
  });

  it("refuses when nothing matching is pending", () => {
    const store = createConfirmationStore();

    expect(store.redeem({ ...TURN_2, ...base })).toEqual({ ok: false, reason: "none" });

    store.request({ ...TURN_1, ...base });
    expect(store.redeem({ ...TURN_2, tool: "t", fingerprint: "other" })).toEqual({
      ok: false,
      reason: "none",
    });
  });

  it("keeps only the latest request per chat", () => {
    const store = createConfirmationStore();
    store.request({ ...TURN_1, tool: "t", fingerprint: "first" });
    store.request({ ...TURN_1, tool: "t", fingerprint: "second" });

    // Asking for one thing and then another leaves only the second waiting.
    expect(store.redeem({ ...TURN_2, tool: "t", fingerprint: "first" })).toEqual({
      ok: false,
      reason: "none",
    });
    expect(store.redeem({ ...TURN_2, tool: "t", fingerprint: "second" })).toEqual({ ok: true });
  });

  it("does not leak a confirmation into another chat", () => {
    const store = createConfirmationStore();
    store.request({ ...TURN_1, ...base });

    expect(store.redeem({ chatId: "chat-2", turnId: "turn-2", ...base })).toEqual({
      ok: false,
      reason: "none",
    });
  });

  it("spends a confirmation once only", () => {
    const store = createConfirmationStore();
    store.request({ ...TURN_1, ...base });

    expect(store.redeem({ ...TURN_2, ...base })).toEqual({ ok: true });
    // One yes must not authorise a second deletion.
    expect(store.redeem({ chatId: "chat-1", turnId: "turn-3", ...base })).toEqual({
      ok: false,
      reason: "none",
    });
  });

  it("expires a request that was never answered", () => {
    let now = 0;
    const store = createConfirmationStore({ ttlMs: 1000, now: () => now });
    store.request({ ...TURN_1, ...base });

    now = 1001;

    expect(store.redeem({ ...TURN_2, ...base })).toEqual({ ok: false, reason: "expired" });
  });

  it("ignores key order when fingerprinting arguments", () => {
    expect(fingerprintOf("t", { a: 1, b: 2 })).toBe(fingerprintOf("t", { b: 2, a: 1 }));
    expect(fingerprintOf("t", { a: 1 })).not.toBe(fingerprintOf("t", { a: 2 }));
    expect(fingerprintOf("t", { a: 1 })).not.toBe(fingerprintOf("u", { a: 1 }));
  });
});

describe("destructive tools", () => {
  it("does not delete anything on the first call", async () => {
    deleted.length = 0;
    const registry = registryWith();

    const result = await registry.execute(
      call("c1", "delete_calendar_event", { event_id: "abc" }),
      TURN_1,
    );

    expect(deleted).toEqual([]);
    expect(parse(result.content).error?.code).toBe("confirmation_required");
    expect(parse(result.content).error?.message).toContain("abc");
  });

  it("still refuses when the model tries to answer itself in the same turn", async () => {
    // The whole point: without a turn boundary the model could call, read the
    // refusal, call again and delete without the user ever seeing a word.
    deleted.length = 0;
    const registry = registryWith();

    await registry.execute(call("c1", "delete_calendar_event", { event_id: "abc" }), TURN_1);
    const second = await registry.execute(
      call("c2", "delete_calendar_event", { event_id: "abc" }),
      TURN_1,
    );

    expect(deleted).toEqual([]);
    expect(parse(second.content).error?.code).toBe("confirmation_required");
  });

  it("deletes when the same call is repeated while handling the next message", async () => {
    deleted.length = 0;
    const registry = registryWith();

    await registry.execute(call("c1", "delete_calendar_event", { event_id: "abc" }), TURN_1);
    const second = await registry.execute(
      call("c2", "delete_calendar_event", { event_id: "abc" }),
      TURN_2,
    );

    expect(deleted).toEqual(["abc"]);
    expect(second.isError).toBeUndefined();
  });

  it("will not let a yes for one event delete another", async () => {
    deleted.length = 0;
    const registry = registryWith();

    await registry.execute(call("c1", "delete_calendar_event", { event_id: "abc" }), TURN_1);
    const second = await registry.execute(
      call("c2", "delete_calendar_event", { event_id: "xyz" }),
      TURN_2,
    );

    expect(deleted).toEqual([]);
    expect(parse(second.content).error?.code).toBe("confirmation_required");
  });

  it("asks again for a second deletion, rather than reusing the first yes", async () => {
    deleted.length = 0;
    const registry = registryWith();

    await registry.execute(call("c1", "delete_calendar_event", { event_id: "abc" }), TURN_1);
    await registry.execute(call("c2", "delete_calendar_event", { event_id: "abc" }), TURN_2);
    const third = await registry.execute(call("c3", "delete_calendar_event", { event_id: "abc" }), {
      chatId: "chat-1",
      turnId: "turn-3",
    });

    expect(deleted).toEqual(["abc"]);
    expect(parse(third.content).error?.code).toBe("confirmation_required");
  });

  it("asks only when the arguments make the call destructive", async () => {
    const registry = registryWith();

    const harmless = await registry.execute(
      call("c1", "update_project", { name: "Atlas", status: "active" }),
      TURN_1,
    );
    const archiving = await registry.execute(
      call("c2", "update_project", { name: "Atlas", status: "archived" }),
      TURN_1,
    );

    expect(harmless.isError).toBeUndefined();
    expect(parse(archiving.content).error?.code).toBe("confirmation_required");
  });

  it("keeps the advertised schema free of confirmation machinery", async () => {
    // The model follows the protocol by repeating the call, not by carrying a
    // token: the tool result that would hold one is dropped with the turn.
    const registry = registryWith();
    const spec = registry.specs.find((s) => s.name === "delete_calendar_event");

    expect(Object.keys((spec?.inputSchema.properties ?? {}) as object)).toEqual(["event_id"]);
  });
});
