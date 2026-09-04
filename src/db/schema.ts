import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Authoritative structured state: the database, not the model, is the source of
 * truth for projects, tasks and tracked time.
 * All instants are stored as `timestamptz` in UTC; user input is interpreted in
 * the configured timezone and resolved to an absolute instant before it gets here.
 */

export const projectStatus = pgEnum("project_status", [
  "active",
  "paused",
  "completed",
  "archived",
]);

export const taskStatus = pgEnum("task_status", ["open", "done", "cancelled"]);

export const taskPriority = pgEnum("task_priority", ["low", "medium", "high"]);

/**
 * Reminder lifecycle:
 *   pending   — scheduled, never delivered
 *   delivered — sent to the chat at least once
 *   snoozed   — delivered, then postponed; scheduled again
 *   cancelled — called off by the user
 *
 * `snoozed` is deliberately distinct from `pending`: a postponed reminder has
 * already interrupted the user once, and collapsing the two would lose that.
 */
export const reminderStatus = pgEnum("reminder_status", [
  "pending",
  "delivered",
  "snoozed",
  "cancelled",
]);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    status: projectStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Users refer to projects by name in chat ("add X to atlas"), so names must
    // resolve unambiguously regardless of casing.
    uniqueIndex("projects_name_lower_unique").on(sql`lower(${t.name})`),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tasks may exist without a project; deleting a project keeps its tasks.
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatus("status").notNull().default("open"),
    priority: taskPriority("priority"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("tasks_project_idx").on(t.projectId),
    // Drives "what is open / due / overdue", the hottest read in the briefing.
    index("tasks_status_due_idx").on(t.status, t.dueAt),
    check(
      "tasks_completed_at_matches_status",
      sql`(${t.status} = 'done') = (${t.completedAt} IS NOT NULL)`,
    ),
  ],
);

export const workSessions = pgTable(
  "work_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    note: text("note"),
  },
  (t) => [
    index("work_sessions_project_idx").on(t.projectId),
    // At most one running timer, enforced by the database rather than by
    // application code. Indexing a constant over the open rows only allows
    // exactly one row with ended_at IS NULL.
    uniqueIndex("work_sessions_single_active")
      .on(sql`((${t.endedAt}) IS NULL)`)
      .where(sql`${t.endedAt} IS NULL`),
    check(
      "work_sessions_ended_after_started",
      sql`${t.endedAt} IS NULL OR ${t.endedAt} > ${t.startedAt}`,
    ),
  ],
);

export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Who to deliver to is a fact about the reminder, not about the current
    // environment: a reminder queued today stays deliverable even if the
    // configured allowlist changes tomorrow.
    chatId: text("chat_id").notNull(),
    message: text("message").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: reminderStatus("status").notNull().default("pending"),
    /** The pg-boss job currently scheduled for this reminder, if any. */
    jobId: text("job_id"),
    snoozeCount: integer("snooze_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    // Drives the catch-up sweep at startup and every "what is still due" read.
    index("reminders_due_idx").on(t.status, t.dueAt),
    // A reminder that has never been delivered cannot carry a delivery time,
    // and one that has been delivered must. Cancelled is left free: it can be
    // reached either before or after a delivery.
    check(
      "reminders_pending_not_delivered",
      sql`${t.status} <> 'pending' OR ${t.deliveredAt} IS NULL`,
    ),
    check(
      "reminders_delivered_has_timestamp",
      sql`${t.status} NOT IN ('delivered', 'snoozed') OR ${t.deliveredAt} IS NOT NULL`,
    ),
    check("reminders_snooze_count_non_negative", sql`${t.snoozeCount} >= 0`),
  ],
);

/**
 * Audit trail.
 *
 * Two kinds of row: one per tool call, written by the registry, and one per
 * user turn, written by the agent loop. Both already existed as log lines; the
 * table is what makes them outlive the process, so tool-selection accuracy,
 * latency and cost can be measured over weeks instead of over a `tail -f`.
 *
 * This is the first table here that grows monotonically — one row per tool
 * call, forever — so it is swept on a retention window rather than kept.
 */
export const auditEventType = pgEnum("audit_event_type", ["tool_call", "agent_turn"]);

export const auditStatus = pgEnum("audit_status", ["ok", "error"]);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    eventType: auditEventType("event_type").notNull(),
    /** The tool that ran. Set on `tool_call` rows only. */
    tool: text("tool"),
    /**
     * Argument *shape*, never argument values: `{"title":"string(24)"}`.
     *
     * Tool arguments carry the user's own words — task titles, reminder texts,
     * event names — and this is the one table kept for months. Names, types and
     * sizes are what the accuracy metrics need; the values would only turn the
     * audit trail into a second copy of every conversation.
     */
    arguments: jsonb("arguments").$type<Record<string, string>>(),
    status: auditStatus("status").notNull(),
    /** Domain code (`not_found`, `invalid_input`, …) when `status` is `error`. */
    errorCode: text("error_code"),
    latencyMs: integer("latency_ms"),
    /** Model that served the turn. Set on `agent_turn` rows only. */
    model: text("model"),
    /** Provider round trips the turn took. Set on `agent_turn` rows only. */
    iterations: integer("iterations"),
    /** Token counters, cache hits included, as reported by the provider. */
    tokenCostMetadata: jsonb("token_cost_metadata").$type<Record<string, number>>(),
  },
  (t) => [
    // The two reads this table gets: recent activity, and the retention sweep.
    index("audit_events_timestamp_idx").on(t.timestamp),
    // Per-tool accuracy and latency — the metrics spec §18 asks to preserve.
    index("audit_events_tool_idx").on(t.tool, t.timestamp),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type WorkSession = typeof workSessions.$inferSelect;
export type NewWorkSession = typeof workSessions.$inferInsert;
export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
