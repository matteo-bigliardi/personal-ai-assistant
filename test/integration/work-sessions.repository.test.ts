import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkSessionsRepository,
  type WorkSessionsRepository,
} from "../../src/db/repositories/work-sessions.js";
import {
  createProjectsRepository,
  type ProjectsRepository,
} from "../../src/db/repositories/projects.js";
import type { Project } from "../../src/db/schema.js";
import { ConflictError } from "../../src/domain/errors.js";
import { setupTestDb } from "./helpers/db.js";

/**
 * These run against a real Postgres because the behaviour under test lives in
 * the database: `work_sessions_single_active` is a partial unique index and
 * `work_sessions_ended_after_started` is a CHECK, and no fake can prove either
 * holds. Without a reachable server the suite skips rather than fails.
 */
const testDb = await setupTestDb();
const describeDb = testDb ? describe : describe.skip;

if (!testDb) {
  console.warn("[integration] no Postgres reachable — skipping repository tests");
}

/** Drizzle wraps driver errors, so the constraint name sits on a `cause`. */
function constraintOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === "string") return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function rejectingConstraint(write: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await write();
  } catch (err) {
    return constraintOf(err);
  }
  throw new Error("expected the write to be rejected");
}

const at = (iso: string) => new Date(iso);

describeDb("work sessions repository", () => {
  let repo: WorkSessionsRepository;
  let projects: ProjectsRepository;
  let atlas: Project;
  let borealis: Project;

  beforeEach(async () => {
    await testDb?.truncate();
    if (testDb) {
      repo = createWorkSessionsRepository(testDb.db);
      projects = createProjectsRepository(testDb.db);
      atlas = await projects.create({ name: "Atlas" });
      borealis = await projects.create({ name: "Borealis" });
    }
  });

  afterAll(async () => {
    await testDb?.close();
  });

  it("starts a timer and finds it as the active one", async () => {
    const started = await repo.start({
      projectId: atlas.id,
      startedAt: at("2026-08-31T08:00:00Z"),
    });

    const active = await repo.findActive();

    expect(active?.id).toBe(started.id);
    expect(active?.endedAt).toBeNull();
    expect(active?.projectName).toBe("Atlas");
  });

  it("refuses a second running timer, even on another project", async () => {
    // The partial unique index is the authority: checking first and inserting
    // after would race with itself.
    await repo.start({ projectId: atlas.id, startedAt: at("2026-08-31T08:00:00Z") });

    await expect(
      repo.start({ projectId: borealis.id, startedAt: at("2026-08-31T09:00:00Z") }),
    ).rejects.toThrow(ConflictError);
  });

  it("allows a new timer once the previous one is closed", async () => {
    const first = await repo.start({ projectId: atlas.id, startedAt: at("2026-08-31T08:00:00Z") });
    await repo.stop(first.id, at("2026-08-31T09:00:00Z"));

    const second = await repo.start({
      projectId: borealis.id,
      startedAt: at("2026-08-31T09:00:00Z"),
    });

    expect((await repo.findActive())?.id).toBe(second.id);
  });

  it("refuses a session that ends when it started", async () => {
    // The CHECK is a strict `>`: a session with no duration is not a fact.
    const instant = at("2026-08-31T08:00:00Z");

    expect(
      await rejectingConstraint(() =>
        repo.add({ projectId: atlas.id, startedAt: instant, endedAt: instant }),
      ),
    ).toBe("work_sessions_ended_after_started");
  });

  it("refuses a session that ends before it started", async () => {
    expect(
      await rejectingConstraint(() =>
        repo.add({
          projectId: atlas.id,
          startedAt: at("2026-08-31T09:00:00Z"),
          endedAt: at("2026-08-31T08:00:00Z"),
        }),
      ),
    ).toBe("work_sessions_ended_after_started");
  });

  it("refuses to stop a session that is already closed", async () => {
    const started = await repo.start({
      projectId: atlas.id,
      startedAt: at("2026-08-31T08:00:00Z"),
    });
    await repo.stop(started.id, at("2026-08-31T09:00:00Z"));

    // Stopping again must not move the end time it already has.
    expect(await repo.stop(started.id, at("2026-08-31T10:00:00Z"))).toBeUndefined();
  });

  it("returns only sessions overlapping the range", async () => {
    await repo.add({
      projectId: atlas.id,
      startedAt: at("2026-08-29T08:00:00Z"),
      endedAt: at("2026-08-29T09:00:00Z"),
    });
    const spanning = await repo.add({
      projectId: atlas.id,
      startedAt: at("2026-08-30T23:00:00Z"),
      endedAt: at("2026-08-31T01:00:00Z"),
    });
    const inside = await repo.add({
      projectId: atlas.id,
      startedAt: at("2026-08-31T08:00:00Z"),
      endedAt: at("2026-08-31T09:00:00Z"),
    });

    const overlapping = await repo.listOverlapping({
      from: at("2026-08-31T00:00:00Z"),
      to: at("2026-09-01T00:00:00Z"),
    });

    // A session straddling the lower bound counts: clipping is the domain's job.
    expect(overlapping.map((s) => s.id).sort()).toEqual([spanning.id, inside.id].sort());
  });

  it("treats a running session as overlapping any range that has not ended", async () => {
    const running = await repo.start({
      projectId: atlas.id,
      startedAt: at("2026-08-31T08:00:00Z"),
    });

    const overlapping = await repo.listOverlapping({
      from: at("2026-08-31T00:00:00Z"),
      to: at("2026-09-01T00:00:00Z"),
    });

    expect(overlapping.map((s) => s.id)).toEqual([running.id]);
  });

  it("excludes a session that ends exactly at the lower bound", async () => {
    // Bounds are half-open: [from, to). A session ending at `from` contributes
    // nothing to the period and must not appear.
    await repo.add({
      projectId: atlas.id,
      startedAt: at("2026-08-30T23:00:00Z"),
      endedAt: at("2026-08-31T00:00:00Z"),
    });

    expect(
      await repo.listOverlapping({
        from: at("2026-08-31T00:00:00Z"),
        to: at("2026-09-01T00:00:00Z"),
      }),
    ).toHaveLength(0);
  });

  it("excludes a session that starts exactly at the upper bound", async () => {
    await repo.add({
      projectId: atlas.id,
      startedAt: at("2026-09-01T00:00:00Z"),
      endedAt: at("2026-09-01T01:00:00Z"),
    });

    expect(
      await repo.listOverlapping({
        from: at("2026-08-31T00:00:00Z"),
        to: at("2026-09-01T00:00:00Z"),
      }),
    ).toHaveLength(0);
  });

  it("filters by project and joins its name", async () => {
    await repo.add({
      projectId: atlas.id,
      startedAt: at("2026-08-31T08:00:00Z"),
      endedAt: at("2026-08-31T09:00:00Z"),
    });
    await repo.add({
      projectId: borealis.id,
      startedAt: at("2026-08-31T09:00:00Z"),
      endedAt: at("2026-08-31T10:00:00Z"),
    });

    const onlyAtlas = await repo.listOverlapping({ projectId: atlas.id });

    expect(onlyAtlas).toHaveLength(1);
    expect(onlyAtlas[0]?.projectName).toBe("Atlas");
  });

  it("loses its sessions when the project is deleted", async () => {
    // `on delete cascade`: tracked time has no meaning without its project,
    // unlike a task, which survives with a null project.
    await repo.add({
      projectId: atlas.id,
      startedAt: at("2026-08-31T08:00:00Z"),
      endedAt: at("2026-08-31T09:00:00Z"),
    });

    await testDb?.pool.query("DELETE FROM projects WHERE id = $1", [atlas.id]);

    expect(await repo.listOverlapping({})).toHaveLength(0);
  });

  it("stores instants in UTC and reads them back unchanged", async () => {
    const startedAt = at("2026-08-31T08:00:00.000Z");
    const added = await repo.add({
      projectId: atlas.id,
      startedAt,
      endedAt: at("2026-08-31T09:00:00.000Z"),
    });

    const reread = await repo.listOverlapping({ projectId: atlas.id });

    expect(reread[0]?.startedAt.toISOString()).toBe(startedAt.toISOString());
    expect(reread[0]?.id).toBe(added.id);
  });
});
