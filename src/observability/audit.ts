import type { AuditRepository, AuditEventStatus } from "../db/repositories/audit.js";
import type { Logger } from "./logger.js";

/**
 * The audit sink: the policy layer between what happens and what is kept.
 *
 * Two rules shape everything here.
 *
 *  - **Shape, not content.** Tool arguments are the user's own words, and this
 *    is the only table kept for months. What goes in is the name, type and size
 *    of each argument — enough to measure whether the model picks the right
 *    tool and fills it in correctly, and not enough to reconstruct a single
 *    sentence anyone said.
 *  - **Auditing never breaks the thing it audits.** If the insert fails the
 *    task was still created, so the error is logged and swallowed. The write is
 *    awaited rather than fired and forgotten: an unawaited promise loses its
 *    ordering, and loses the row outright if the process exits first. One local
 *    round trip is invisible next to the model call that caused it.
 */

export interface ToolCallAudit {
  tool: string;
  /** Raw model input, before validation: the shape actually sent. */
  input: unknown;
  status: AuditEventStatus;
  errorCode?: string | undefined;
  latencyMs: number;
}

export interface AgentTurnAudit {
  status: AuditEventStatus;
  /** Provider round trips the turn took. */
  iterations: number;
  latencyMs: number;
  model?: string | undefined;
  errorCode?: string | undefined;
  tokens?: Record<string, number> | undefined;
}

/**
 * Implementations must never reject. Both call sites await one of these on
 * the path of a side effect that has already happened, so a rejection would
 * turn a successful action into a failed one.
 */
export interface AuditSink {
  toolCall(event: ToolCallAudit): Promise<void>;
  agentTurn(event: AgentTurnAudit): Promise<void>;
}

/** Describes one value by type and size, never by content. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  switch (typeof value) {
    case "string":
      return `string(${value.length})`;
    case "object":
      return `object{${Object.keys(value as object).length}}`;
    case "number":
    case "boolean":
    case "undefined":
      return typeof value;
    default:
      return typeof value;
  }
}

/**
 * Turns a tool's arguments into `{ name: shape }`.
 *
 * The input is whatever the model sent, so it is not necessarily an object:
 * a malformed call is recorded as such rather than dropped, because "the model
 * passed a string where an object goes" is exactly the kind of thing the
 * argument-correctness metric exists to count.
 */
export function describeArguments(input: unknown): Record<string, string> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { "(root)": describeValue(input) };
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) out[key] = describeValue(value);
  return out;
}

export interface AuditSinkOptions {
  repo: AuditRepository;
  logger: Logger;
  now?: () => Date;
}

export function createAuditSink(opts: AuditSinkOptions): AuditSink {
  const { repo, logger } = opts;
  const clock = opts.now ?? (() => new Date());

  async function write(what: string, record: () => Promise<void>): Promise<void> {
    try {
      await record();
    } catch (err) {
      logger.error("audit.write_failed", {
        event: what,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    async toolCall(event) {
      await write("tool_call", () =>
        repo.record({
          timestamp: clock(),
          eventType: "tool_call",
          tool: event.tool,
          arguments: describeArguments(event.input),
          status: event.status,
          errorCode: event.errorCode,
          latencyMs: event.latencyMs,
        }),
      );
    },

    async agentTurn(event) {
      await write("agent_turn", () =>
        repo.record({
          timestamp: clock(),
          eventType: "agent_turn",
          status: event.status,
          errorCode: event.errorCode,
          latencyMs: event.latencyMs,
          model: event.model,
          iterations: event.iterations,
          tokenCostMetadata: event.tokens,
        }),
      );
    },
  };
}

/** Used wherever there is no database: the smoke script, most unit tests. */
export function createNoopAuditSink(): AuditSink {
  return {
    async toolCall() {},
    async agentTurn() {},
  };
}
