import type { AgentTurnAudit, AuditSink, ToolCallAudit } from "../../src/observability/audit.js";

export interface RecordingAuditSink extends AuditSink {
  toolCalls: ToolCallAudit[];
  turns: AgentTurnAudit[];
}

/** An audit sink that keeps what it was given, so tests can assert on it. */
export function createRecordingAuditSink(): RecordingAuditSink {
  const toolCalls: ToolCallAudit[] = [];
  const turns: AgentTurnAudit[] = [];
  return {
    toolCalls,
    turns,
    async toolCall(event) {
      toolCalls.push(event);
    },
    async agentTurn(event) {
      turns.push(event);
    },
  };
}
