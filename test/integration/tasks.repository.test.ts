import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTasksRepository, type TasksRepository } from "../../src/db/repositories/tasks.js";
import {
  createProjectsRepository,
  type ProjectsRepository,
} from "../../src/db/repositories/projects.js";
import { setupTestDb } from "./helpers/db.js";

/**
 * These run against a real Postgres because the behaviour under test lives in
 * the database: `tasks_completed_at_matches_status` is what makes an
 * inconsistent task impossible rather than merely unlikely, and the ordering
 * and the join are SQL, not application code. Without a reachable server the
 * suite skips rather than fails.
 */
const testDb = await setupTestDb();
const describeDb = testDb ? describe : describe.skip;

if (!testDb) {
  console.warn("[integration] no Postgres reachable — skipping repository tests");
}

/**
 * Drizzle wraps driver errors, so the constraint name is not on the error it
 * throws but somewhere down its `cause` chain — the same wrapping that once
 * hid unique violations from the projects repository. Walk the chain rather
 * than matching on a message, so these tests name the constraint that actually
 * fired instead of merely observing that something went wrong.
 */
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

describeDb("tasks repository", () => {
  let repo: TasksRepository;
  let projects: ProjectsRepository;

  beforeEach(async () => {
    await testDb?.truncate();
    if (testDb) {
      repo = createTasksRepository(testDb.db);
      projects = createProjectsRepository(testDb.db);
    }
  });

  afterAll(async () => {
    await testDb?.close();
  });

  it("creates a task with defaults", async () => {
    const task = await repo.create({ title: "prepare demo" });

    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.title).toBe("prepare demo");
    expect(task.status).toBe("open");
    expect(task.projectId).toBeNull();
    expect(task.dueAt).toBeNull();
    expect(task.completedAt).toBeNull();
    expect(task.createdAt).toBeInstanceOf(Date);
    // The column was added after the table existed; prove it is really there.
    expect(task.updatedAt).toBeInstanceOf(Date);
  });

  it("bumps updated_at without ever landing before created_at", async () => {
    // The clock skew trap: column defaults come from the database container's
    // clock, `new Date()` from the host's. Both timestamps must come from one.
    const created = await repo.create({ title: "prepare demo" });
    const updated = await repo.update(created.id, { title: "prepare the demo" });

    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.createdAt.getTime());
    expect(updated?.createdAt.getTime()).toBe(created.createdAt.getTime());
  });

  it("joins the project name onto reads", async () => {
    const atlas = await projects.create({ name: "Atlas" });
    await repo.create({ title: "attached", projectId: atlas.id });
    await repo.create({ title: "loose" });

    const listed = await repo.list({ limit: 10 });

    expect(listed.find((t) => t.title === "attached")?.projectName).toBe("Atlas");
    expect(listed.find((t) => t.title === "loose")?.projectName).toBeNull();
  });

  it("orders by deadline with undated tasks last", async () => {
    await repo.create({ title: "undated" });
    await repo.create({ title: "later", dueAt: new Date("2026-09-10T12:00:00Z") });
    await repo.create({ title: "sooner", dueAt: new Date("2026-09-01T12:00:00Z") });

    const listed = await repo.list({ limit: 10 });

    // Postgres sorts nulls first on ascending order by default, which would put
    // everything with no deadline at the top of every listing.
    expect(listed.map((t) => t.title)).toEqual(["sooner", "later", "undated"]);
  });

  it("filters by status, project and deadline, and caps by limit", async () => {
    const atlas = await projects.create({ name: "Atlas" });
    const other = await projects.create({ name: "Borealis" });
    const soon = await repo.create({
      title: "soon",
      projectId: atlas.id,
      dueAt: new Date("2026-09-01T12:00:00Z"),
    });
    await repo.create({
      title: "late",
      projectId: atlas.id,
      dueAt: new Date("2026-10-01T12:00:00Z"),
    });
    await repo.create({ title: "elsewhere", projectId: other.id });
    await repo.update(soon.id, { status: "done", completedAt: new Date() });

    expect((await repo.list({ statuses: ["open"], limit: 10 })).map((t) => t.title)).toEqual([
      "late",
      "elsewhere",
    ]);
    expect((await repo.list({ projectId: atlas.id, limit: 10 })).map((t) => t.title)).toEqual([
      "soon",
      "late",
    ]);
    // An undated task is not "due before" anything.
    expect(
      (await repo.list({ dueBefore: new Date("2026-09-15T00:00:00Z"), limit: 10 })).map(
        (t) => t.title,
      ),
    ).toEqual(["soon"]);
    expect(await repo.list({ limit: 1 })).toHaveLength(1);
  });

  it("resolves a short id prefix and reports collisions", async () => {
    const task = await repo.create({ title: "prepare demo" });
    const prefix = task.id.slice(0, 8);

    const matches = await repo.findByIdPrefix(prefix, 2);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.title).toBe("prepare demo");
    expect(await repo.findByIdPrefix("ffffffff-ffff", 2)).toHaveLength(0);
  });

  it("refuses a done task without a completion time", async () => {
    const task = await repo.create({ title: "prepare demo" });

    expect(await rejectingConstraint(() => repo.update(task.id, { status: "done" }))).toBe(
      "tasks_completed_at_matches_status",
    );
  });

  it("refuses an open task that still carries a completion time", async () => {
    const task = await repo.create({ title: "prepare demo" });
    await repo.update(task.id, { status: "done", completedAt: new Date() });

    expect(await rejectingConstraint(() => repo.update(task.id, { status: "open" }))).toBe(
      "tasks_completed_at_matches_status",
    );
  });

  it("refuses a cancelled task that carries a completion time", async () => {
    const task = await repo.create({ title: "prepare demo" });
    await repo.update(task.id, { status: "done", completedAt: new Date() });

    expect(await rejectingConstraint(() => repo.update(task.id, { status: "cancelled" }))).toBe(
      "tasks_completed_at_matches_status",
    );
  });

  it("accepts the transitions the domain actually performs", async () => {
    const task = await repo.create({ title: "prepare demo" });

    const done = await repo.update(task.id, { status: "done", completedAt: new Date() });
    expect(done?.status).toBe("done");

    const reopened = await repo.update(task.id, { status: "open", completedAt: null });
    expect(reopened?.completedAt).toBeNull();

    const cancelled = await repo.update(task.id, { status: "cancelled", completedAt: null });
    expect(cancelled?.status).toBe("cancelled");
  });

  it("keeps a task when its project is deleted", async () => {
    // `on delete set null`: losing a project must not silently lose the work
    // recorded against it.
    const atlas = await projects.create({ name: "Atlas" });
    const task = await repo.create({ title: "prepare demo", projectId: atlas.id });

    await testDb?.pool.query("DELETE FROM projects WHERE id = $1", [atlas.id]);

    const reread = await repo.findById(task.id);
    expect(reread?.title).toBe("prepare demo");
    expect(reread?.projectId).toBeNull();
  });

  it("stores instants in UTC and reads them back unchanged", async () => {
    const dueAt = new Date("2026-09-04T21:59:59.000Z");
    const task = await repo.create({ title: "prepare demo", dueAt });

    const reread = await repo.findById(task.id);
    expect(reread?.dueAt?.toISOString()).toBe(dueAt.toISOString());
  });

  it("returns undefined when updating an unknown id", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    expect(await repo.update(missing, { title: "ghost" })).toBeUndefined();
  });
});
