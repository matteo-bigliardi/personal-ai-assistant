import { and, asc, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { Database } from "../client.js";
import { projects, workSessions, type WorkSession } from "../schema.js";
import { ConflictError } from "../../domain/errors.js";

/**
 * Persistence for tracked work. This layer owns SQL and nothing else: no
 * policy, no formatting, no knowledge of the chat or of the model.
 */

/** A session together with the name of the project it was logged against. */
export interface WorkSessionWithProject extends WorkSession {
  projectName: string;
}

export interface StartWorkSessionInput {
  projectId: string;
  startedAt: Date;
  note?: string | null | undefined;
}

export interface AddWorkSessionInput extends StartWorkSessionInput {
  endedAt: Date;
}

export interface OverlappingInput {
  projectId?: string | undefined;
  /** Half-open bounds: a session counts when it overlaps `[from, to)`. */
  from?: Date | undefined;
  to?: Date | undefined;
}

export interface WorkSessionsRepository {
  findActive(): Promise<WorkSessionWithProject | undefined>;
  start(input: StartWorkSessionInput): Promise<WorkSession>;
  add(input: AddWorkSessionInput): Promise<WorkSession>;
  stop(id: string, endedAt: Date): Promise<WorkSession | undefined>;
  /** Every session overlapping the range, oldest first. */
  listOverlapping(input: OverlappingInput): Promise<WorkSessionWithProject[]>;
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

export function createWorkSessionsRepository(db: Database): WorkSessionsRepository {
  const selectWithProject = () =>
    db
      .select({ session: workSessions, projectName: projects.name })
      .from(workSessions)
      .innerJoin(projects, eq(workSessions.projectId, projects.id));

  const withProject = (
    rows: { session: WorkSession; projectName: string }[],
  ): WorkSessionWithProject[] => rows.map((r) => ({ ...r.session, projectName: r.projectName }));

  return {
    async findActive() {
      const rows = await selectWithProject().where(isNull(workSessions.endedAt)).limit(1);
      return withProject(rows)[0];
    },

    async start({ projectId, startedAt, note }) {
      try {
        const [row] = await db
          .insert(workSessions)
          .values({ projectId, startedAt, endedAt: null, note: note ?? null })
          .returning();
        if (!row) throw new Error("insert returned no row");
        return row;
      } catch (err) {
        // `work_sessions_single_active` is the authority on how many timers may
        // run: checking first and inserting after would race with itself.
        if (isUniqueViolation(err)) {
          throw new ConflictError("A timer is already running.");
        }
        throw err;
      }
    },

    async add({ projectId, startedAt, endedAt, note }) {
      const [row] = await db
        .insert(workSessions)
        .values({ projectId, startedAt, endedAt, note: note ?? null })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return row;
    },

    async stop(id, endedAt) {
      const [row] = await db
        .update(workSessions)
        .set({ endedAt })
        .where(and(eq(workSessions.id, id), isNull(workSessions.endedAt)))
        .returning();
      return row;
    },

    async listOverlapping({ projectId, from, to }) {
      // A session overlaps [from, to) when it starts before the range ends and
      // ends after the range begins. A running session has no end yet, so it
      // overlaps anything that has not already finished.
      const filters = [
        projectId ? eq(workSessions.projectId, projectId) : undefined,
        to ? lt(workSessions.startedAt, to) : undefined,
        from ? or(isNull(workSessions.endedAt), gt(workSessions.endedAt, from)) : undefined,
      ].filter((f) => f !== undefined);

      const rows = await selectWithProject()
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(asc(workSessions.startedAt));
      return withProject(rows);
    },
  };
}
