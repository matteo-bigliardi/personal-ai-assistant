import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { projects, tasks, type Task } from "../schema.js";

/**
 * Persistence for tasks. This layer owns SQL and nothing else: no policy,
 * no formatting, no knowledge of the chat or of the model.
 */

export type TaskStatus = Task["status"];

/**
 * A task together with the name of the project it belongs to. Reads join
 * rather than looking projects up one by one: a listing of twenty tasks would
 * otherwise cost twenty extra round trips to render one column.
 */
export interface TaskWithProject extends Task {
  projectName: string | null;
}

export type TaskPriority = NonNullable<Task["priority"]>;

export interface CreateTaskInput {
  projectId?: string | null | undefined;
  title: string;
  description?: string | null | undefined;
  priority?: TaskPriority | null | undefined;
  dueAt?: Date | null | undefined;
}

export interface UpdateTaskInput {
  projectId?: string | null | undefined;
  title?: string | undefined;
  description?: string | null | undefined;
  status?: TaskStatus | undefined;
  priority?: TaskPriority | null | undefined;
  dueAt?: Date | null | undefined;
  /** Kept consistent with `status` by the domain; the database CHECKs it. */
  completedAt?: Date | null | undefined;
}

export interface ListTasksInput {
  /** Statuses to include. Omitted or empty means every status. */
  statuses?: TaskStatus[] | undefined;
  projectId?: string | undefined;
  /** Upper bound on `due_at`; tasks with no due date are excluded when set. */
  dueBefore?: Date | undefined;
  limit: number;
}

export interface TasksRepository {
  create(input: CreateTaskInput): Promise<Task>;
  list(input: ListTasksInput): Promise<TaskWithProject[]>;
  findById(id: string): Promise<TaskWithProject | undefined>;
  /**
   * Tasks are addressed by a short id prefix, so a lookup can legitimately
   * match more than one row. Returns up to `limit` matches and lets the caller
   * decide what an ambiguous reference means.
   */
  findByIdPrefix(prefix: string, limit: number): Promise<TaskWithProject[]>;
  update(id: string, patch: UpdateTaskInput): Promise<Task | undefined>;
}

export function createTasksRepository(db: Database): TasksRepository {
  const selectWithProject = () =>
    db
      .select({ task: tasks, projectName: projects.name })
      .from(tasks)
      .leftJoin(projects, eq(tasks.projectId, projects.id));

  const withProject = (rows: { task: Task; projectName: string | null }[]): TaskWithProject[] =>
    rows.map((r) => ({ ...r.task, projectName: r.projectName }));

  return {
    async create({ projectId, title, description, priority, dueAt }) {
      // The application clock is the single authority for domain timestamps;
      // the column defaults are only a safety net. See the projects repository.
      const at = new Date();
      const [row] = await db
        .insert(tasks)
        .values({
          projectId: projectId ?? null,
          title,
          description: description ?? null,
          priority: priority ?? null,
          dueAt: dueAt ?? null,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return row;
    },

    async list({ statuses, projectId, dueBefore, limit }) {
      const filters = [
        statuses?.length ? inArray(tasks.status, statuses) : undefined,
        projectId ? eq(tasks.projectId, projectId) : undefined,
        dueBefore ? lte(tasks.dueAt, dueBefore) : undefined,
      ].filter((f) => f !== undefined);

      const rows = await selectWithProject()
        .where(filters.length ? and(...filters) : undefined)
        // Soonest deadline first; undated tasks last rather than first, which
        // is what `nulls last` buys over Postgres' default for ascending sorts.
        .orderBy(sql`${tasks.dueAt} asc nulls last`, asc(tasks.createdAt))
        .limit(limit);
      return withProject(rows);
    },

    async findById(id) {
      const rows = await selectWithProject().where(eq(tasks.id, id)).limit(1);
      return withProject(rows)[0];
    },

    async findByIdPrefix(prefix, limit) {
      // The caller guarantees the prefix is hexadecimal-with-dashes, so it
      // carries no LIKE wildcards of its own.
      const rows = await selectWithProject()
        .where(sql`${tasks.id}::text LIKE ${`${prefix}%`}`)
        .orderBy(asc(tasks.createdAt))
        .limit(limit);
      return withProject(rows);
    },

    async update(id, patch) {
      const values: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.projectId !== undefined) values.projectId = patch.projectId;
      if (patch.title !== undefined) values.title = patch.title;
      if (patch.description !== undefined) values.description = patch.description;
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.priority !== undefined) values.priority = patch.priority;
      if (patch.dueAt !== undefined) values.dueAt = patch.dueAt;
      if (patch.completedAt !== undefined) values.completedAt = patch.completedAt;

      const [row] = await db.update(tasks).set(values).where(eq(tasks.id, id)).returning();
      return row;
    },
  };
}
