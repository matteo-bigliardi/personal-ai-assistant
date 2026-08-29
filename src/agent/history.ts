import type { Turn } from "./providers/types.js";

/**
 * Short conversational memory.
 *
 * The assistant's real memory is the database: it answers "what is open on
 * Atlas?" by calling a tool, not by re-reading the transcript. This store
 * exists only so anaphora work — "mark that one done", "move it to tomorrow".
 *
 * Only completed exchanges are kept, as plain user/assistant text. The
 * intermediate tool_use and tool_result blocks live inside the current turn and
 * are dropped once the turn ends, for two reasons: they are the bulk of the
 * context (one task listing outweighs ten chat messages), and they are stale
 * data — a model that can re-read yesterday's listing in the prompt will answer
 * from it instead of calling the tool again.
 *
 * Nothing is persisted: history is not authoritative state, and losing it on
 * restart costs the user one repeated sentence.
 */

export interface ConversationStoreOptions {
  /** Completed exchanges retained per chat. */
  maxExchanges?: number;
  /** Upper bound on retained characters, whichever limit bites first. */
  maxChars?: number;
  /** Idle time after which a conversation is considered over. */
  ttlMs?: number;
  now?: () => number;
}

export interface ConversationStore {
  /** Prior exchanges, oldest first, always starting with a user turn. */
  get(chatId: string): Turn[];
  append(chatId: string, userText: string, assistantText: string): void;
  clear(chatId: string): void;
}

interface Exchange {
  user: string;
  assistant: string;
  at: number;
}

export function createConversationStore(opts: ConversationStoreOptions = {}): ConversationStore {
  const maxExchanges = opts.maxExchanges ?? 4;
  const maxChars = opts.maxChars ?? 4_000;
  const ttlMs = opts.ttlMs ?? 30 * 60_000;
  const now = opts.now ?? Date.now;

  const chats = new Map<string, Exchange[]>();

  function live(chatId: string): Exchange[] {
    const all = chats.get(chatId) ?? [];
    const cutoff = now() - ttlMs;
    const fresh = all.filter((e) => e.at >= cutoff);

    // Trim from the oldest end so the window always starts on a user turn and
    // never leaves a dangling half-exchange.
    let chars = fresh.reduce((sum, e) => sum + e.user.length + e.assistant.length, 0);
    let start = 0;
    while (start < fresh.length && (fresh.length - start > maxExchanges || chars > maxChars)) {
      const dropped = fresh[start];
      if (dropped) chars -= dropped.user.length + dropped.assistant.length;
      start++;
    }

    const kept = fresh.slice(start);
    if (kept.length !== all.length) chats.set(chatId, kept);
    return kept;
  }

  return {
    get(chatId) {
      return live(chatId).flatMap((e): Turn[] => [
        { role: "user", text: e.user },
        { role: "assistant", text: e.assistant },
      ]);
    },

    append(chatId, userText, assistantText) {
      const kept = live(chatId);
      kept.push({ user: userText, assistant: assistantText, at: now() });
      chats.set(chatId, kept);
    },

    clear(chatId) {
      chats.delete(chatId);
    },
  };
}
