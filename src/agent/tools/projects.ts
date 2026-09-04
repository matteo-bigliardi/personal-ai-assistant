import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tool-registry.js";
import { PROJECT_STATUSES, type ProjectsService } from "../../domain/projects/service.js";
import type { Project } from "../../db/schema.js";
import { formatInstant } from "../../domain/datetime.js";

/**
 * Project tools.
 *
 * Projects are addressed by name, never by id: the user says "atlas", names
 * are unique case-insensitively, and keeping 36-character UUIDs out of the
 * context saves tokens and removes a whole class of mistakes where the model
 * invents or mistypes an identifier.
 */

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

const nameArg = z.string().min(1).max(120).describe("The project name, as the user says it.");

interface ProjectView {
  name: string;
  status: string;
  description?: string;
  created_at: string;
}

function view(project: Project, timeZone: string): ProjectView {
  return {
    name: project.name,
    status: project.status,
    ...(project.description ? { description: project.description } : {}),
    created_at: formatInstant(project.createdAt, timeZone),
  };
}

export function createProjectTools(service: ProjectsService, timeZone: string): ToolDefinition[] {
  return [
    defineTool({
      name: "create_project",
      description:
        "Create a new project. Project names are unique regardless of casing; " +
        "creating one that already exists fails, so use update_project to change an existing one.",
      schema: z.object({
        name: nameArg,
        description: z.string().max(500).optional().describe("Optional one-line purpose."),
      }),
      async execute({ name, description }) {
        const project = await service.create({ name, description });
        return { created: view(project, timeZone) };
      },
    }),

    defineTool({
      name: "list_projects",
      description:
        "List projects, most useful to check what exists before creating or referencing one. " +
        "Returns every project except archived ones unless a status is given.",
      schema: z.object({
        status: z
          .enum(PROJECT_STATUSES)
          .optional()
          .describe(
            "Filter by exactly this status. Omit for everything except archived; " +
              "pass 'archived' to see archived projects.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIST_LIMIT)
          .optional()
          .describe(`Maximum projects to return (default ${DEFAULT_LIST_LIMIT}).`),
      }),
      async execute({ status, limit }) {
        const projects = await service.list({ status, limit: limit ?? DEFAULT_LIST_LIMIT });
        return { count: projects.length, projects: projects.map((p) => view(p, timeZone)) };
      },
    }),

    defineTool({
      name: "get_project",
      description: "Get one project by name. Fails if no project with that name exists.",
      schema: z.object({ name: nameArg }),
      async execute({ name }) {
        const project = await service.getByName(name);
        return { project: view(project, timeZone) };
      },
    }),

    defineTool({
      name: "update_project",
      // Archiving is the soft delete, and it hides the project and its tasks
      // from every default listing — destructive enough to be worth a question.
      // Every other update is not, which is why this looks at the arguments.
      confirm: ({ name, status }) =>
        status === "archived"
          ? `About to archive the project "${name}", hiding it and its tasks from listings.`
          : undefined,
      description:
        "Change a project's name, description or status. " +
        "Set status to 'completed' or 'archived' instead of deleting a project.",
      schema: z.object({
        name: nameArg,
        new_name: z.string().min(1).max(120).optional().describe("Rename the project."),
        description: z
          .string()
          .max(500)
          .optional()
          .describe("Replace the description; an empty string clears it."),
        status: z.enum(PROJECT_STATUSES).optional().describe("New status."),
      }),
      async execute({ name, new_name, description, status }) {
        const project = await service.update(name, {
          ...(new_name !== undefined ? { newName: new_name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(status !== undefined ? { status } : {}),
        });
        return { updated: view(project, timeZone) };
      },
    }),
  ];
}
