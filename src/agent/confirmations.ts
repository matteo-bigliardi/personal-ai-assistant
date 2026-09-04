import { createHash } from "node:crypto";

/**
 * Confirmations for destructive actions.
 *
 * The model already tends to stop and ask before deleting something, because
 * the tool descriptions tell it to. That is goodwill, not a guarantee: nothing
 * stops a model from deleting first and reporting afterwards. This makes it
 * structural.
 *
 * The mechanism is a **turn boundary**. The first attempt at a destructive call
 * never runs: it records what was asked for and comes back refused. Only an
 * identical call made while handling a *later* message goes through, so the
 * assistant must end its turn — which means saying something to the user — and
 * the user must speak again before anything is destroyed.
 *
 * There is deliberately **no token for the model to carry**. An earlier version
 * handed one back in the tool result and required it as an argument, and it
 * could not work: completed turns keep only the user and assistant text, so the
 * token was gone by the time the user said yes and the assistant could only ask
 * again, forever. The pending request lives here instead, where the history
 * policy cannot reach it.
 *
 * What is pending is bound to a fingerprint of the exact arguments, so
 * permission to delete the 16:00 meeting cannot be spent on the 17:00 one, and
 * only the **latest** destructive request per chat is kept: asking for one thing
 * and then another means only the second one is waiting for a yes.
 *
 * Residual gap, accepted: within the TTL, a model that spontaneously repeats the
 * same destructive call in a later turn would find the request pending. The user
 * was asked about exactly that action moments earlier, and the window is short.
 *
 * Nothing is persisted: a restart costs the user one repeated question, which is
 * the safe direction to fail in.
 */

export interface ConfirmationRequest {
  chatId: string;
  /** Identifies the message being handled. See the turn-boundary rule above. */
  turnId: string;
  tool: string;
  /** Stable digest of the validated arguments. */
  fingerprint: string;
}

export type RedeemResult = { ok: true } | { ok: false; reason: "none" | "same_turn" | "expired" };

export interface ConfirmationStore {
  /** Records what is waiting for a yes, replacing this chat's earlier request. */
  request(request: ConfirmationRequest): void;
  /** Consumes a matching request made while handling an earlier message. */
  redeem(request: ConfirmationRequest): RedeemResult;
}

export interface ConfirmationStoreOptions {
  /** How long a pending request stays confirmable. */
  ttlMs?: number;
  now?: () => number;
}

interface Pending {
  turnId: string;
  tool: string;
  fingerprint: string;
  requestedAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** A stable digest of a tool call, so a yes cannot be spent on another one. */
export function fingerprintOf(tool: string, args: unknown): string {
  return createHash("sha256")
    .update(`${tool} ${stableStringify(args)}`)
    .digest("hex");
}

/** JSON with object keys sorted, so key order cannot change the digest. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export function createConfirmationStore(opts: ConfirmationStoreOptions = {}): ConfirmationStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const clock = opts.now ?? (() => Date.now());
  const pending = new Map<string, Pending>();

  return {
    request({ chatId, turnId, tool, fingerprint }) {
      pending.set(chatId, { turnId, tool, fingerprint, requestedAt: clock() });
    },

    redeem({ chatId, turnId, tool, fingerprint }) {
      const entry = pending.get(chatId);
      if (!entry || entry.tool !== tool || entry.fingerprint !== fingerprint) {
        return { ok: false, reason: "none" };
      }
      if (clock() - entry.requestedAt > ttlMs) {
        pending.delete(chatId);
        return { ok: false, reason: "expired" };
      }
      // The whole point: the user must have been spoken to and answered.
      if (entry.turnId === turnId) return { ok: false, reason: "same_turn" };

      // Single use, so one yes cannot authorise two deletions.
      pending.delete(chatId);
      return { ok: true };
    },
  };
}
