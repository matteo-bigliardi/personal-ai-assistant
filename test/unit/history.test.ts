import { describe, expect, it } from "vitest";
import { createConversationStore } from "../../src/agent/history.js";

describe("createConversationStore", () => {
  it("starts empty", () => {
    expect(createConversationStore().get("chat")).toEqual([]);
  });

  it("returns completed exchanges as alternating turns", () => {
    const store = createConversationStore();
    store.append("chat", "create Atlas", "Created.");

    expect(store.get("chat")).toEqual([
      { role: "user", text: "create Atlas" },
      { role: "assistant", text: "Created." },
    ]);
  });

  it("keeps conversations separate", () => {
    const store = createConversationStore();
    store.append("a", "hello", "hi");
    expect(store.get("b")).toEqual([]);
  });

  it("drops the oldest exchanges beyond the window", () => {
    const store = createConversationStore({ maxExchanges: 2 });
    store.append("chat", "one", "1");
    store.append("chat", "two", "2");
    store.append("chat", "three", "3");

    const turns = store.get("chat");
    expect(turns).toHaveLength(4);
    expect(turns[0]).toEqual({ role: "user", text: "two" });
  });

  it("drops whole exchanges when the character budget is exceeded", () => {
    const store = createConversationStore({ maxExchanges: 10, maxChars: 40 });
    store.append("chat", "x".repeat(30), "y".repeat(30));
    store.append("chat", "short", "ok");

    const turns = store.get("chat");
    expect(turns).toEqual([
      { role: "user", text: "short" },
      { role: "assistant", text: "ok" },
    ]);
  });

  it("always starts the window on a user turn", () => {
    const store = createConversationStore({ maxExchanges: 1 });
    store.append("chat", "one", "1");
    store.append("chat", "two", "2");

    expect(store.get("chat")[0]?.role).toBe("user");
  });

  it("forgets a conversation that has gone idle", () => {
    let clock = 1_000;
    const store = createConversationStore({ ttlMs: 60_000, now: () => clock });
    store.append("chat", "still there?", "yes");

    clock += 59_000;
    expect(store.get("chat")).toHaveLength(2);

    clock += 2_000;
    expect(store.get("chat")).toEqual([]);
  });

  it("clears on request", () => {
    const store = createConversationStore();
    store.append("chat", "hello", "hi");
    store.clear("chat");
    expect(store.get("chat")).toEqual([]);
  });
});
