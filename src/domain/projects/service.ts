import { projectStatus, type Project } from "../../db/schema.js";
import type {
  ProjectsRepository,
  ProjectStatus,
  UpdateProjectInput,
} from "../../db/repositories/projects.js";
import { InvalidInputError, NotFoundError } from "../errors.js";

/**
 * Project rules, independent of Telegram, of the model and of SQL.
 *
 * Chat refers to projects by name ("add a task to atlas"), so name resolution
 * is a first-class operation here and is case-insensitive, matching the unique
 * index that enforces it in the database.
 */

export const MAX_NAME_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 500;

export const PROJECT_STATUSES = projectStatus.enumValues;

/**
 * Status semantics:
 *   active    — in flight; the only status the morning briefing considers
 *   paused    — deliberately on hold; still listed, tasks untouched
 *   completed — finished
 *   archived  — hidden; this is the soft delete, there is no delete_project
 *
 * So the default listing hides archived projects and nothing else: someone
 * asking "what projects do I have?" wants to see the paused ones, not the
 * graveyard. Derived from the enum rather than hard-coded, so a status added
 * later shows up by default instead of silently disappearing.
 */
export const HIDDEN_FROM_DEFAULT_LIST: ProjectStatus[] = ["archived"];

export const DEFAULT_LIST_STATUSES: ProjectStatus[] = PROJECT_STATUSES.filter(
  (status) => !HIDDEN_FROM_DEFAULT_LIST.includes(status),
);

export interface ProjectsService {
  create(input: { name: string; description?: string | undefined }): Promise<Project>;
  list(input: { status?: ProjectStatus | undefined; limit: number }): Promise<Project[]>;
  /** Resolves a name to a project, or throws `NotFoundError`. */
  getByName(name: string): Promise<Project>;
  update(
    name: string,
    patch: { newName?: string; description?: string; status?: ProjectStatus },
  ): Promise<Project>;
}

function normaliseName(raw: string): string {
  // Collapse internal whitespace so "Atlas  X" and "Atlas X" cannot coexist as
  // two projects the user believes are one.
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) throw new InvalidInputError("A project name cannot be empty.");
  if (name.length > MAX_NAME_LENGTH) {
    throw new InvalidInputError(`A project name cannot exceed ${MAX_NAME_LENGTH} characters.`);
  }
  return name;
}

function normaliseDescription(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const description = raw.trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new InvalidInputError(
      `A project description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters.`,
    );
  }
  return description;
}

export function createProjectsService(repo: ProjectsRepository): ProjectsService {
  async function getByName(rawName: string): Promise<Project> {
    const name = normaliseName(rawName);
    const project = await repo.findByName(name);
    if (!project) throw new NotFoundError(`No project named "${name}".`);
    return project;
  }

  return {
    async create({ name, description }) {
      return repo.create({
        name: normaliseName(name),
        description: normaliseDescription(description),
      });
    },

    async list({ status, limit }) {
      // An explicit status is honoured as asked, archived included: the filter
      // is how you go looking for archived projects on purpose.
      return repo.list({ statuses: status ? [status] : DEFAULT_LIST_STATUSES, limit });
    },

    getByName,

    async update(name, patch) {
      const project = await getByName(name);

      const values: UpdateProjectInput = {};
      if (patch.newName !== undefined) values.name = normaliseName(patch.newName);
      if (patch.description !== undefined) {
        // An explicit empty string clears the description.
        const description = normaliseDescription(patch.description);
        values.description = description === "" ? null : description;
      }
      if (patch.status !== undefined) values.status = patch.status;

      if (Object.keys(values).length === 0) {
        throw new InvalidInputError(
          "Nothing to update: provide a new name, description or status.",
        );
      }

      const updated = await repo.update(project.id, values);
      if (!updated) throw new NotFoundError(`No project named "${name}".`);
      return updated;
    },
  };
}
