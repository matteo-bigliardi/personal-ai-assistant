import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tool-registry.js";
import {
  TASK_PRIORITIES,
  TASK_REF_LENGTH,
  TASK_STATUSES,
  taskRef,
  type TasksService,
} from "../../domain/tasks/service.js";
import type { TaskWithProject } from "../../db/repositories/tasks.js";
import { DUE_FORMAT_HINT, formatInstant, parseDueAt } from "../../domain/datetime.js";

/**
 * Task tools.
 *
 * Tasks are addressed by a short id, not by title: titles are not unique, so
 * "mark the demo done" would otherwise be a guess. Every listing shows that id
 * next to the task, and the model passes it straight back — the full 36
 * characters would be paid for on every turn to buy nothing.
 */

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

const refArg = z
  .string()
  .min(1)
  .max(36)
  .describe(`The ${TASK_REF_LENGTH}-character task id shown in a task listing.`);

const dueArg = z.string().min(1).max(40).describe(`When the task is due: ${DUE_FORMAT_HINT}.`);

const projectArg = z
  .string()
  .min(1)
  .max(120)
  .describe("Name of the project the task belongs to; it must already exist.");

interface TaskView {
  id: string;
  title: string;
  status: string;
  project?: string;
  priority?: string;
  description?: string;
  due_at?: string;
  completed_at?: string;
}

function view(task: TaskWithProject, timeZone: string): TaskView {
  return {
    id: taskRef(task),
    title: task.title,
    status: task.status,
    ...(task.projectName ? { project: task.projectName } : {}),
    ...(task.priority ? { priority: task.priority } : {}),
    ...(task.description ? { description: task.description } : {}),
    ...(task.dueAt ? { due_at: formatInstant(task.dueAt, timeZone) } : {}),
    ...(task.completedAt ? { completed_at: formatInstant(task.completedAt, timeZone) } : {}),
  };
}

export function createTaskTools(service: TasksService, timeZone: string): ToolDefinition[] {
  return [
    defineTool({
      name: "create_task",
      description:
        "Create a task, optionally attached to an existing project. " +
        "A due date given as a plain calendar date means the end of that day, " +
        "so a task due Friday is not late on Friday morning.",
      schema: z.object({
        title: z.string().min(1).max(200).describe("What has to be done, as the user put it."),
        project: projectArg.optional(),
        description: z.string().max(500).optional().describe("Optional extra detail."),
        priority: z.enum(TASK_PRIORITIES).optional().describe("Only if the user implied one."),
        due_at: dueArg.optional(),
      }),
      async execute({ title, project, description, priority, due_at }) {
        const task = await service.create({
          title,
          ...(project !== undefined ? { projectName: project } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(due_at !== undefined ? { dueAt: parseDueAt(due_at, timeZone) } : {}),
        });
        return { created: view(task, timeZone) };
      },
    }),

    defineTool({
      name: "list_tasks",
      description:
        "List tasks, and the way to get the ids the other task tools need. " +
        "Returns only open tasks unless a status is given.",
      schema: z.object({
        status: z
          .enum(TASK_STATUSES)
          .optional()
          .describe(
            "Filter by exactly this status. Omit for open tasks only; " +
              "pass 'done' or 'cancelled' to see finished ones.",
          ),
        project: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe("Only tasks of this project. Omit for tasks across all projects."),
        due_before: dueArg
          .optional()
          .describe(
            `Only tasks due at or before this point, undated tasks excluded: ${DUE_FORMAT_HINT}. ` +
              "Use today's date to ask what is due today or already overdue.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIST_LIMIT)
          .optional()
          .describe(`Maximum tasks to return (default ${DEFAULT_LIST_LIMIT}).`),
      }),
      async execute({ status, project, due_before, limit }) {
        const tasks = await service.list({
          ...(status !== undefined ? { status } : {}),
          ...(project !== undefined ? { projectName: project } : {}),
          ...(due_before !== undefined ? { dueBefore: parseDueAt(due_before, timeZone) } : {}),
          limit: limit ?? DEFAULT_LIST_LIMIT,
        });
        return { count: tasks.length, tasks: tasks.map((t) => view(t, timeZone)) };
      },
    }),

    defineTool({
      name: "complete_task",
      description:
        "Mark a task done. Reports whether it was already done rather than failing, " +
        "so a repeated request does not move the completion time.",
      schema: z.object({ task_id: refArg }),
      async execute({ task_id }) {
        const { task, alreadyDone } = await service.complete(task_id);
        return { completed: view(task, timeZone), already_done: alreadyDone };
      },
    }),

    defineTool({
      name: "update_task",
      description:
        "Change a task: title, description, status, priority, due date or project. " +
        "Set status to 'cancelled' instead of deleting a task, and to 'open' to reopen one.",
      schema: z.object({
        task_id: refArg,
        title: z.string().min(1).max(200).optional().describe("Replace the title."),
        description: z
          .string()
          .max(500)
          .optional()
          .describe("Replace the description; an empty string clears it."),
        status: z.enum(TASK_STATUSES).optional().describe("New status."),
        priority: z.enum(TASK_PRIORITIES).optional().describe("New priority."),
        due_at: dueArg.optional().describe(
          // A null-able argument would be a second way to say "absent" in a
          // JSON Schema the model already reads as optional; a sentinel the
          // description names is harder to get wrong.
          `Replace the due date: ${DUE_FORMAT_HINT}. Pass "none" to clear it.`,
        ),
        project: z
          .string()
          .max(120)
          .optional()
          .describe("Move the task to this project; an empty string detaches it from any project."),
      }),
      async execute({ task_id, title, description, status, priority, due_at, project }) {
        const task = await service.update(task_id, {
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(due_at !== undefined
            ? {
                dueAt: due_at.trim().toLowerCase() === "none" ? null : parseDueAt(due_at, timeZone),
              }
            : {}),
          ...(project !== undefined ? { projectName: project } : {}),
        });
        return { updated: view(task, timeZone) };
      },
    }),
  ];
}
