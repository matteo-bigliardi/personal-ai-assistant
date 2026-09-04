import { and, desc, eq, lt } from "drizzle-orm";
import type { Database } from "../client.js";
import { auditEvents, type AuditEvent } from "../schema.js";

/**
 * Persistence for the audit trail. This layer owns SQL and nothing else: it
 * does not decide what is worth recording, does not shape arguments and does
 * not swallow failures — that policy lives in `observability/audit.ts`.
 */

export type AuditEventType = AuditEvent["eventType"];
export type AuditEventStatus = AuditEvent["status"];

export interface RecordAuditEventInput {
  timestamp: Date;
  eventType: AuditEventType;
  status: AuditEventStatus;
  tool?: string | undefined;
  /** Argument shape, not argument values. See the column comment in the schema. */
  arguments?: Record<string, string> | undefined;
  errorCode?: string | undefined;
  latencyMs?: number | undefined;
  model?: string | undefined;
  iterations?: number | undefined;
  tokenCostMetadata?: Record<string, number> | undefined;
}

export interface ListAuditEventsInput {
  eventType?: AuditEventType | undefined;
  tool?: string | undefined;
  limit: number;
}

export interface AuditRepository {
  record(input: RecordAuditEventInput): Promise<void>;
  /** Most recent first. Reading is for analysis, never for the model. */
  list(input: ListAuditEventsInput): Promise<AuditEvent[]>;
  /** Drops everything older than `cutoff`. Returns how many rows went. */
  deleteOlderThan(cutoff: Date): Promise<number>;
}

export function createAuditRepository(db: Database): AuditRepository {
  return {
    async record(input) {
      await db.insert(auditEvents).values(input);
    },

    async list({ eventType, tool, limit }) {
      const filters = [
        eventType ? eq(auditEvents.eventType, eventType) : undefined,
        tool ? eq(auditEvents.tool, tool) : undefined,
      ].filter((f) => f !== undefined);

      return db
        .select()
        .from(auditEvents)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(auditEvents.timestamp))
        .limit(limit);
    },

    async deleteOlderThan(cutoff) {
      const rows = await db
        .delete(auditEvents)
        .where(lt(auditEvents.timestamp, cutoff))
        .returning({ id: auditEvents.id });
      return rows.length;
    },
  };
}
