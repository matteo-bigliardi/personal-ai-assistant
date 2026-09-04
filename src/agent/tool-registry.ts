import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import { createNoopAuditSink, type AuditSink } from "../observability/audit.js";
import type { Logger } from "../observability/logger.js";
import { createConfirmationStore, fingerprintOf, type ConfirmationStore } from "./confirmations.js";
import type { ToolCall, ToolResult, ToolSpec } from "./providers/types.js";

/**
 * Typed tool boundary. The model is never given generic SQL, shell or
 * filesystem access: every capability is a named tool with a schema, and the
 * schema is the single source of truth for both the JSON Schema advertised to
 * the model and the runtime validation of what comes back.
 *
 * A tool result is always structured, and a failure is a normal result with
 * `isError` set rather than a thrown exception, so the model can read the
 * reason and correct itself within the same turn.
 *
 * This is the one place every tool call passes through, which makes it where
 * two cross-cutting rules are enforced rather than hoped for: the audit trail
 * is written here, and a destructive action cannot run here until the user has
 * been asked in an earlier turn.
 */

/** Results larger than this are truncated to keep the context bounded. */
const MAX_RESULT_CHARS = 8_000;

/**
 * Per-turn facts a tool may need that are not arguments the model chooses.
 * The chat a message came from is the assistant's own knowledge, not something
 * the model should be able to name — a reminder must be delivered where it was
 * asked for, whatever the model puts in its arguments.
 */
export interface ToolContext {
  chatId: string;
  /**
   * Identifies the user message being handled. A confirmation issued under one
   * turn id may only be spent under a different one, which is what forces the
   * assistant to actually ask before it destroys anything.
   */
  turnId: string;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  /** Shown to the model. Say when to use the tool, not how it is implemented. */
  description: string;
  schema: S;
  /**
   * Decides whether this particular call needs the user's blessing, and says
   * what is about to happen. Returning a string demands confirmation and gives
   * the sentence the user should see; returning undefined lets the call run.
   *
   * It takes the arguments because destructiveness usually depends on them:
   * `update_project` is harmless until the status is `archived`.
   */
  confirm?(input: z.output<S>): string | undefined;
  execute(input: z.output<S>, context: ToolContext): Promise<unknown>;
}

/** Preserves the schema's inferred type through to `execute` and `confirm`. */
export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

export interface ToolRegistry {
  specs: ToolSpec[];
  has(name: string): boolean;
  execute(call: ToolCall, context: ToolContext): Promise<ToolResult>;
}

function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;
  // The provider supplies its own schema dialect wrapper.
  delete json.$schema;
  return json;
}

function serialise(value: unknown): string {
  const text = value === undefined ? "null" : JSON.stringify(value);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}… [truncated: ask for a narrower query]`;
}

function errorResult(id: string, code: string, message: string): ToolResult {
  return { id, content: JSON.stringify({ error: { code, message } }), isError: true };
}

export interface ToolRegistryOptions {
  audit?: AuditSink;
  confirmations?: ConfirmationStore;
}

export function createToolRegistry(
  defs: ToolDefinition[],
  logger: Logger,
  options: ToolRegistryOptions = {},
): ToolRegistry {
  const audit = options.audit ?? createNoopAuditSink();
  const confirmations = options.confirmations ?? createConfirmationStore();

  const byName = new Map<string, ToolDefinition>();
  for (const def of defs) {
    if (byName.has(def.name)) throw new Error(`Duplicate tool name: ${def.name}`);
    byName.set(def.name, def);
  }

  const specs: ToolSpec[] = defs.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: toInputSchema(def.schema),
  }));

  return {
    specs,
    has: (name) => byName.has(name),

    async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
      const start = Date.now();

      // Every exit from this method goes through here, so no path can be added
      // later that quietly escapes the audit.
      const done = async (result: ToolResult, errorCode?: string): Promise<ToolResult> => {
        await audit.toolCall({
          tool: call.name,
          input: call.input,
          status: result.isError ? "error" : "ok",
          errorCode,
          latencyMs: Date.now() - start,
        });
        return result;
      };

      const def = byName.get(call.name);
      if (!def) {
        // Worth recording rather than dropping: a tool the model invented is a
        // tool-selection failure, which is one of the numbers this table is for.
        logger.warn("tool.unknown", { tool: call.name });
        return done(
          errorResult(call.id, "unknown_tool", `No tool named "${call.name}".`),
          "unknown_tool",
        );
      }

      const parsed = def.schema.safeParse(call.input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        logger.warn("tool.invalid_input", { tool: call.name, issues });
        return done(
          errorResult(call.id, "invalid_input", `Invalid arguments — ${issues}`),
          "invalid_input",
        );
      }

      const needed = def.confirm?.(parsed.data);
      if (needed !== undefined) {
        const request = {
          chatId: context.chatId,
          turnId: context.turnId,
          tool: def.name,
          fingerprint: fingerprintOf(def.name, parsed.data),
        };

        const redeemed = confirmations.redeem(request);
        if (!redeemed.ok) {
          // Record what was asked for and refuse. The identical call, made
          // while handling the user's next message, is what goes through.
          confirmations.request(request);
          logger.info("tool.confirmation_required", { tool: call.name, was: redeemed.reason });
          return done(
            errorResult(
              call.id,
              "confirmation_required",
              `${needed} NOTHING HAS BEEN DONE. Tell the user exactly what is about to happen ` +
                `and stop there: end your turn without calling any more tools. If they agree, ` +
                `call this tool again, with the same arguments, when handling their reply.`,
            ),
            "confirmation_required",
          );
        }
        logger.info("tool.confirmed", { tool: call.name });
      }

      try {
        const output = await def.execute(parsed.data, context);
        logger.info("tool.call", { tool: call.name, ok: true, latencyMs: Date.now() - start });
        return done({ id: call.id, content: serialise(output) });
      } catch (err) {
        const latencyMs = Date.now() - start;
        if (err instanceof DomainError) {
          // Expected outcome: the model gets the reason and can retry.
          logger.info("tool.call", {
            tool: call.name,
            ok: false,
            code: err.code,
            latencyMs,
          });
          return done(errorResult(call.id, err.code, err.message), err.code);
        }
        // Unexpected fault: log the detail, tell the model nothing specific.
        logger.error("tool.failed", {
          tool: call.name,
          latencyMs,
          error: err instanceof Error ? err.message : String(err),
        });
        return done(
          errorResult(call.id, "internal_error", "The tool failed unexpectedly."),
          "internal_error",
        );
      }
    },
  };
}
