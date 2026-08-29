import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { projects, type Project } from "../schema.js";
import { ConflictError } from "../../domain/errors.js";

/**
 * Persistence for projects. This layer owns SQL and nothing else: no policy,
 * no formatting, no knowledge of the chat or of the model.
 */

export type ProjectStatus = Project["status"];

export interface CreateProjectInput {
  name: string;
  description?: string | undefined;
}

export interface UpdateProjectInput {
  name?: string | undefined;
  description?: string | null | undefined;
  status?: ProjectStatus | undefined;
}

export interface ListProjectsInput {
  /** Statuses to include. Omitted or empty means every status. */
  statuses?: ProjectStatus[] | undefined;
  limit: number;
}

export interface ProjectsRepository {
  create(input: CreateProjectInput): Promise<Project>;
  list(input: ListProjectsInput): Promise<Project[]>;
  findByName(name: string): Promise<Project | undefined>;
  findById(id: string): Promise<Project | undefined>;
  update(id: string, patch: UpdateProjectInput): Promise<Project | undefined>;
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/**
 * Drizzle wraps driver errors, so the SQLSTATE sits on a `cause` rather than on
 * the error itself. Walk the chain instead of inspecting only the top level.
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function createProjectsRepository(db: Database): ProjectsRepository {
  return {
    async create({ name, description }) {
      // The application clock is the single authority for domain timestamps.
      // The column defaults use the database's `now()`, which is the start of
      // the current transaction and comes from a different machine's clock in
      // a containerised deployment: mixing the two makes an updated_at land
      // before its own created_at. Defaults stay in the schema as a safety net
      // for anything written outside this repository.
      const at = new Date();
      try {
        const [row] = await db
          .insert(projects)
          .values({ name, description: description ?? null, createdAt: at, updatedAt: at })
          .returning();
        // `returning()` on a successful single insert always yields one row.
        if (!row) throw new Error("insert returned no row");
        return row;
      } catch (err) {
        // The case-insensitive unique index is the authority on duplicates:
        // checking first and inserting after would race with itself.
        if (isUniqueViolation(err)) {
          throw new ConflictError(`A project named "${name}" already exists.`);
        }
        throw err;
      }
    },

    async list({ statuses, limit }) {
      // Which statuses are worth showing is policy, and policy lives in the
      // domain: this layer only applies the filter it is handed.
      return db
        .select()
        .from(projects)
        .where(statuses?.length ? inArray(projects.status, statuses) : undefined)
        .orderBy(asc(projects.name))
        .limit(limit);
    },

    async findByName(name) {
      // Compares against the expression backing projects_name_lower_unique, so
      // the lookup uses that index.
      const [row] = await db
        .select()
        .from(projects)
        .where(sql`lower(${projects.name}) = ${name.toLowerCase()}`)
        .limit(1);
      return row;
    },

    async findById(id) {
      const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      return row;
    },

    async update(id, patch) {
      const values: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.description !== undefined) values.description = patch.description;
      if (patch.status !== undefined) values.status = patch.status;

      try {
        const [row] = await db
          .update(projects)
          .set(values)
          .where(and(eq(projects.id, id)))
          .returning();
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(`A project named "${patch.name}" already exists.`);
        }
        throw err;
      }
    },
  };
}
