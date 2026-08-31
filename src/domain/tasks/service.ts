import { taskPriority, taskStatus } from "../../db/schema.js";
import type {
  TaskPriority,
  TaskStatus,
  TasksRepository,
  TaskWithProject,
  UpdateTaskInput,
} from "../../db/repositories/tasks.js";
import type { ProjectsService } from "../projects/service.js";
import { InvalidInputError, NotFoundError } from "../errors.js";
import { normaliseRef, resolveOne } from "../reference.js";

/**
 * Task rules, independent of Telegram, of the model and of SQL.
 *
 * Unlike projects, tasks are addressed by identifier: titles are not unique, so
 * "mark the demo done" cannot be resolved by text alone. A full UUID would cost
 * 36 characters per task in every listing, so tasks are referenced by a short
 * prefix of their id, resolved back to exactly one row here.
 */

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 500;

export const TASK_STATUSES = taskStatus.enumValues;
export const TASK_PRIORITIES = taskPriority.enumValues;

/**
 * `cancelled` is the soft delete, matching `archived` for projects: there is no
 * delete_task. Both terminal statuses are hidden from the default listing —
 * what is open is the question being asked, and finished work is noise in it.
 * Derived from the enum rather than hard-coded, so a status added later shows
 * up by default instead of silently disappearing.
 */
export const HIDDEN_FROM_DEFAULT_LIST: TaskStatus[] = ["done", "cancelled"];

export const DEFAULT_LIST_STATUSES: TaskStatus[] = TASK_STATUSES.filter(
  (status) => !HIDDEN_FROM_DEFAULT_LIST.includes(status),
);

export interface CreateTaskArgs {
  title: string;
  projectName?: string | undefined;
  description?: string | undefined;
  priority?: TaskPriority | undefined;
  dueAt?: Date | undefined;
}

export interface UpdateTaskArgs {
  title?: string | undefined;
  description?: string | undefined;
  status?: TaskStatus | undefined;
  priority?: TaskPriority | undefined;
  dueAt?: Date | null | undefined;
  /** An empty string detaches the task from its project. */
  projectName?: string | undefined;
}

export interface ListTasksArgs {
  status?: TaskStatus | undefined;
  projectName?: string | undefined;
  dueBefore?: Date | undefined;
  limit: number;
}

export interface TasksService {
  create(args: CreateTaskArgs): Promise<TaskWithProject>;
  list(args: ListTasksArgs): Promise<TaskWithProject[]>;
  /** Resolves a short id reference to one task, or throws. */
  getByRef(ref: string): Promise<TaskWithProject>;
  complete(ref: string): Promise<{ task: TaskWithProject; alreadyDone: boolean }>;
  update(ref: string, patch: UpdateTaskArgs): Promise<TaskWithProject>;
}

function normaliseTitle(raw: string): string {
  const title = raw.trim().replace(/\s+/g, " ");
  if (title.length === 0) throw new InvalidInputError("A task title cannot be empty.");
  if (title.length > MAX_TITLE_LENGTH) {
    throw new InvalidInputError(`A task title cannot exceed ${MAX_TITLE_LENGTH} characters.`);
  }
  return title;
}

function normaliseDescription(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const description = raw.trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new InvalidInputError(
      `A task description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters.`,
    );
  }
  return description;
}

export function createTasksService(repo: TasksRepository, projects: ProjectsService): TasksService {
  async function getByRef(rawRef: string): Promise<TaskWithProject> {
    const ref = normaliseRef(rawRef, "task");
    // Two is enough to tell "exactly one" from "more than one".
    return resolveOne(await repo.findByIdPrefix(ref, 2), ref, "task");
  }

  /**
   * `tasks_completed_at_matches_status` requires completed_at to be set exactly
   * when the status is `done`, so every status change carries its timestamp
   * with it. Keeping that in one place is what stops a reopened task from
   * holding on to a completion time the database would then reject.
   */
  function completionFor(status: TaskStatus, existing: Date | null, now: Date): Date | null {
    if (status !== "done") return null;
    return existing ?? now;
  }

  return {
    async create({ title, projectName, description, priority, dueAt }) {
      const project = projectName ? await projects.getByName(projectName) : undefined;
      const created = await repo.create({
        title: normaliseTitle(title),
        projectId: project?.id ?? null,
        description: normaliseDescription(description) || null,
        priority: priority ?? null,
        dueAt: dueAt ?? null,
      });
      return { ...created, projectName: project?.name ?? null };
    },

    async list({ status, projectName, dueBefore, limit }) {
      // An explicit status is honoured as asked, done and cancelled included:
      // the filter is how you go looking for finished work on purpose.
      const project = projectName ? await projects.getByName(projectName) : undefined;
      return repo.list({
        statuses: status ? [status] : DEFAULT_LIST_STATUSES,
        ...(project ? { projectId: project.id } : {}),
        ...(dueBefore ? { dueBefore } : {}),
        limit,
      });
    },

    getByRef,

    async complete(ref) {
      const task = await getByRef(ref);
      // Completing an already-completed task is not an error: the user is
      // telling us something true. Say so instead of moving the timestamp.
      if (task.status === "done") return { task, alreadyDone: true };

      const updated = await repo.update(task.id, { status: "done", completedAt: new Date() });
      if (!updated) throw new NotFoundError(`No task with id "${ref}".`);
      return { task: { ...updated, projectName: task.projectName }, alreadyDone: false };
    },

    async update(ref, patch) {
      const task = await getByRef(ref);

      const values: UpdateTaskInput = {};
      let projectName = task.projectName;

      if (patch.title !== undefined) values.title = normaliseTitle(patch.title);
      if (patch.description !== undefined) {
        // An explicit empty string clears the description.
        const description = normaliseDescription(patch.description);
        values.description = description ? description : null;
      }
      if (patch.priority !== undefined) values.priority = patch.priority;
      if (patch.dueAt !== undefined) values.dueAt = patch.dueAt;
      if (patch.status !== undefined) {
        values.status = patch.status;
        values.completedAt = completionFor(patch.status, task.completedAt, new Date());
      }
      if (patch.projectName !== undefined) {
        if (patch.projectName.trim() === "") {
          values.projectId = null;
          projectName = null;
        } else {
          const project = await projects.getByName(patch.projectName);
          values.projectId = project.id;
          projectName = project.name;
        }
      }

      if (Object.keys(values).length === 0) {
        throw new InvalidInputError(
          "Nothing to update: provide a title, description, status, priority, due date or project.",
        );
      }

      const updated = await repo.update(task.id, values);
      if (!updated) throw new NotFoundError(`No task with id "${ref}".`);
      return { ...updated, projectName };
    },
  };
}
