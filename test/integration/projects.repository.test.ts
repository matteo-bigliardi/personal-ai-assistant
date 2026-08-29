import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectsRepository,
  type ProjectsRepository,
} from "../../src/db/repositories/projects.js";
import { ConflictError } from "../../src/domain/errors.js";
import { setupTestDb } from "./helpers/db.js";

/**
 * These run against a real Postgres because the behaviour under test lives in
 * the database: the case-insensitive unique index on project names is what
 * makes "atlas" and "Atlas" the same project, and no fake can prove it holds.
 * Without a reachable server the suite skips rather than fails.
 */
const testDb = await setupTestDb();
const describeDb = testDb ? describe : describe.skip;

if (!testDb) {
  console.warn("[integration] no Postgres reachable — skipping repository tests");
}

describeDb("projects repository", () => {
  let repo: ProjectsRepository;

  beforeEach(async () => {
    await testDb?.truncate();
    if (testDb) repo = createProjectsRepository(testDb.db);
  });

  afterAll(async () => {
    await testDb?.close();
  });

  it("creates a project with defaults", async () => {
    const project = await repo.create({ name: "Atlas" });

    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.name).toBe("Atlas");
    expect(project.status).toBe("active");
    expect(project.description).toBeNull();
    expect(project.createdAt).toBeInstanceOf(Date);
  });

  it("finds a project by name regardless of casing", async () => {
    await repo.create({ name: "Atlas" });

    expect((await repo.findByName("atlas"))?.name).toBe("Atlas");
    expect((await repo.findByName("ATLAS"))?.name).toBe("Atlas");
    expect(await repo.findByName("Borealis")).toBeUndefined();
  });

  it("refuses a duplicate name differing only in case", async () => {
    await repo.create({ name: "Atlas" });

    await expect(repo.create({ name: "atlas" })).rejects.toThrow(ConflictError);
    await expect(repo.create({ name: "atlas" })).rejects.toThrow(/already exists/);
  });

  it("lists projects by name, filtered by status and capped by limit", async () => {
    await repo.create({ name: "Charlie" });
    await repo.create({ name: "Alpha" });
    const bravo = await repo.create({ name: "Bravo" });
    await repo.update(bravo.id, { status: "archived" });

    // No filter means no filter: choosing what to hide is the domain's job.
    expect((await repo.list({ limit: 10 })).map((p) => p.name)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    expect((await repo.list({ statuses: [], limit: 10 })).map((p) => p.name)).toHaveLength(3);
    expect((await repo.list({ statuses: ["active"], limit: 10 })).map((p) => p.name)).toEqual([
      "Alpha",
      "Charlie",
    ]);
    expect(await repo.list({ limit: 1 })).toHaveLength(1);
  });

  it("filters on several statuses at once", async () => {
    const alpha = await repo.create({ name: "Alpha" });
    const bravo = await repo.create({ name: "Bravo" });
    await repo.create({ name: "Charlie" });
    await repo.update(alpha.id, { status: "paused" });
    await repo.update(bravo.id, { status: "archived" });

    const visible = await repo.list({ statuses: ["active", "paused", "completed"], limit: 10 });

    expect(visible.map((p) => p.name)).toEqual(["Alpha", "Charlie"]);
  });

  it("updates fields and bumps updated_at", async () => {
    const created = await repo.create({ name: "Atlas", description: "first" });

    const updated = await repo.update(created.id, {
      name: "Atlas Two",
      description: null,
      status: "paused",
    });

    expect(updated?.name).toBe("Atlas Two");
    expect(updated?.description).toBeNull();
    expect(updated?.status).toBe("paused");
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    expect(updated?.createdAt.getTime()).toBe(created.createdAt.getTime());
  });

  it("refuses a rename that collides with another project", async () => {
    await repo.create({ name: "Atlas" });
    const other = await repo.create({ name: "Borealis" });

    await expect(repo.update(other.id, { name: "ATLAS" })).rejects.toThrow(ConflictError);
  });

  it("returns undefined when updating an unknown id", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    expect(await repo.update(missing, { status: "paused" })).toBeUndefined();
  });

  it("stores instants in UTC and reads them back unchanged", async () => {
    const project = await repo.create({ name: "Atlas" });
    const reread = await repo.findById(project.id);

    expect(reread?.createdAt.toISOString()).toBe(project.createdAt.toISOString());
  });
});
