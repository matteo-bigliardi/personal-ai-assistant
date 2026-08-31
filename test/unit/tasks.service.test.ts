import { describe, expect, it } from "vitest";
import { createTasksService, taskRef } from "../../src/domain/tasks/service.js";
import type {
  CreateTaskInput,
  TasksRepository,
  TaskWithProject,
  UpdateTaskInput,
} from "../../src/db/repositories/tasks.js";
import type { ProjectsService } from "../../src/domain/projects/service.js";
import type { Project } from "../../src/db/schema.js";
import { InvalidInputError, NotFoundError } from "../../src/domain/errors.js";

/**
 * In-memory stand-ins. The database enforces the completed_at CHECK in
 * production and the integration tests prove it; here we only exercise the
 * rules the service itself owns — reference resolution, normalisation, and
 * keeping completed_at consistent with every status change.
 */

const EPOCH = new Date("2026-08-01T00:00:00Z");

function fakeProjects(names: string[] = []): ProjectsService {
  const rows: Project[] = names.map((name, i) => ({
    id: `project-${i}`,
    name,
    description: null,
    status: "active",
    createdAt: EPOCH,
    updatedAt: EPOCH,
  }));

  return {
    async create() {
      throw new Error("not used");
    },
    async list() {
      return rows;
    },
    async getByName(name) {
      const row = rows.find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
      if (!row) throw new NotFoundError(`No project named "${name}".`);
      return row;
    },
    async update() {
      throw new Error("not used");
    },
  };
}

function fakeRepo(seed: Partial<TaskWithProject>[] = []): TasksRepository & {
  rows: TaskWithProject[];
} {
  const rows: TaskWithProject[] = seed.map((t, i) => ({
    // Ids are shaped like UUIDs so the reference rules see realistic input.
    id: t.id ?? `aaaaaaa${i}-0000-4000-8000-000000000000`,
    projectId: t.projectId ?? null,
    projectName: t.projectName ?? null,
    title: t.title ?? `task-${i}`,
    description: t.description ?? null,
    status: t.status ?? "open",
    priority: t.priority ?? null,
    dueAt: t.dueAt ?? null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    completedAt: t.completedAt ?? null,
  }));

  return {
    rows,
    async create(input: CreateTaskInput) {
      const row: TaskWithProject = {
        id: `bbbbbbb${rows.length}-0000-4000-8000-000000000000`,
        projectId: input.projectId ?? null,
        projectName: null,
        title: input.title,
        description: input.description ?? null,
        status: "open",
        priority: input.priority ?? null,
        dueAt: input.dueAt ?? null,
        createdAt: EPOCH,
        updatedAt: EPOCH,
        completedAt: null,
      };
      rows.push(row);
      return row;
    },
    async list({ statuses, projectId, dueBefore, limit }) {
      return rows
        .filter((r) => !statuses?.length || statuses.includes(r.status))
        .filter((r) => !projectId || r.projectId === projectId)
        .filter((r) => !dueBefore || (r.dueAt !== null && r.dueAt <= dueBefore))
        .slice(0, limit);
    },
    async findById(id) {
      return rows.find((r) => r.id === id);
    },
    async findByIdPrefix(prefix, limit) {
      return rows.filter((r) => r.id.startsWith(prefix)).slice(0, limit);
    },
    async update(id, patch: UpdateTaskInput) {
      const row = rows.find((r) => r.id === id);
      if (!row) return undefined;
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.description !== undefined) row.description = patch.description;
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.priority !== undefined) row.priority = patch.priority;
      if (patch.dueAt !== undefined) row.dueAt = patch.dueAt;
      if (patch.projectId !== undefined) row.projectId = patch.projectId;
      if (patch.completedAt !== undefined) row.completedAt = patch.completedAt;
      row.updatedAt = new Date();
      return row;
    },
  };
}

const service = (repo: TasksRepository, projects = fakeProjects()) =>
  createTasksService(repo, projects);

describe("tasks service", () => {
  describe("create", () => {
    it("trims and collapses whitespace in the title", async () => {
      const task = await service(fakeRepo()).create({ title: "  prepare   demo " });
      expect(task.title).toBe("prepare demo");
    });

    it("rejects an empty title", async () => {
      await expect(service(fakeRepo()).create({ title: "   " })).rejects.toThrow(InvalidInputError);
    });

    it("rejects an over-long title", async () => {
      await expect(service(fakeRepo()).create({ title: "x".repeat(201) })).rejects.toThrow(
        /200 characters/,
      );
    });

    it("attaches the task to a project given by name", async () => {
      const task = await service(fakeRepo(), fakeProjects(["Atlas"])).create({
        title: "prepare demo",
        projectName: "atlas",
      });

      expect(task.projectId).toBe("project-0");
      expect(task.projectName).toBe("Atlas");
    });

    it("fails when the named project does not exist", async () => {
      await expect(
        service(fakeRepo()).create({ title: "prepare demo", projectName: "Ghost" }),
      ).rejects.toThrow(NotFoundError);
    });

    it("creates an unattached task when no project is given", async () => {
      const task = await service(fakeRepo()).create({ title: "buy milk" });
      expect(task.projectId).toBeNull();
      expect(task.projectName).toBeNull();
    });
  });

  describe("getByRef", () => {
    it("resolves a short id prefix", async () => {
      const repo = fakeRepo([{ title: "prepare demo" }]);
      const ref = taskRef(repo.rows[0]!);

      expect(ref).toHaveLength(8);
      expect((await service(repo).getByRef(ref)).title).toBe("prepare demo");
    });

    it("accepts the full id too", async () => {
      const repo = fakeRepo([{ title: "prepare demo" }]);
      expect((await service(repo).getByRef(repo.rows[0]!.id)).title).toBe("prepare demo");
    });

    it("ignores casing and surrounding space", async () => {
      const repo = fakeRepo([{ title: "prepare demo" }]);
      const ref = taskRef(repo.rows[0]!).toUpperCase();
      expect((await service(repo).getByRef(`  ${ref} `)).title).toBe("prepare demo");
    });

    it("reports an unknown id rather than guessing", async () => {
      await expect(service(fakeRepo()).getByRef("deadbeef")).rejects.toThrow(NotFoundError);
    });

    it("refuses an ambiguous prefix instead of picking one", async () => {
      const repo = fakeRepo([
        { id: "abcdef01-0000-4000-8000-000000000000" },
        { id: "abcdef02-0000-4000-8000-000000000000" },
      ]);

      await expect(service(repo).getByRef("abcdef")).rejects.toThrow(/more than one task/);
    });

    it("rejects a reference that cannot be an id", async () => {
      // "%" would otherwise reach the LIKE pattern as a wildcard.
      await expect(service(fakeRepo()).getByRef("abcd%")).rejects.toThrow(InvalidInputError);
      await expect(service(fakeRepo()).getByRef("prepare demo")).rejects.toThrow(InvalidInputError);
    });

    it("rejects a reference too short to be worth resolving", async () => {
      await expect(service(fakeRepo()).getByRef("ab")).rejects.toThrow(/not a task id/);
    });
  });

  describe("complete", () => {
    it("marks a task done and stamps the completion time", async () => {
      const repo = fakeRepo([{ title: "prepare demo" }]);
      const { task, alreadyDone } = await service(repo).complete(taskRef(repo.rows[0]!));

      expect(task.status).toBe("done");
      expect(task.completedAt).toBeInstanceOf(Date);
      expect(alreadyDone).toBe(false);
    });

    it("reports an already-done task without moving its completion time", async () => {
      const completedAt = new Date("2026-08-10T09:00:00Z");
      const repo = fakeRepo([{ status: "done", completedAt }]);

      const { task, alreadyDone } = await service(repo).complete(taskRef(repo.rows[0]!));

      expect(alreadyDone).toBe(true);
      expect(task.completedAt).toEqual(completedAt);
    });
  });

  describe("update", () => {
    it("clears completed_at when a done task is reopened", async () => {
      // The database CHECK rejects a non-done task that still carries one, so
      // this is a correctness requirement, not a tidiness preference.
      const repo = fakeRepo([{ status: "done", completedAt: new Date() }]);

      const updated = await service(repo).update(taskRef(repo.rows[0]!), { status: "open" });

      expect(updated.status).toBe("open");
      expect(updated.completedAt).toBeNull();
    });

    it("clears completed_at when a done task is cancelled", async () => {
      const repo = fakeRepo([{ status: "done", completedAt: new Date() }]);

      const updated = await service(repo).update(taskRef(repo.rows[0]!), { status: "cancelled" });

      expect(updated.status).toBe("cancelled");
      expect(updated.completedAt).toBeNull();
    });

    it("stamps completed_at when a task is set to done", async () => {
      const repo = fakeRepo([{ status: "open" }]);

      const updated = await service(repo).update(taskRef(repo.rows[0]!), { status: "done" });

      expect(updated.completedAt).toBeInstanceOf(Date);
    });

    it("keeps the original completion time when done is set again", async () => {
      const completedAt = new Date("2026-08-10T09:00:00Z");
      const repo = fakeRepo([{ status: "done", completedAt }]);

      const updated = await service(repo).update(taskRef(repo.rows[0]!), { status: "done" });

      expect(updated.completedAt).toEqual(completedAt);
    });

    it("moves a task to another project", async () => {
      const repo = fakeRepo([{ title: "prepare demo" }]);
      const projects = fakeProjects(["Atlas", "Borealis"]);

      const updated = await service(repo, projects).update(taskRef(repo.rows[0]!), {
        projectName: "borealis",
      });

      expect(updated.projectId).toBe("project-1");
      expect(updated.projectName).toBe("Borealis");
    });

    it("detaches a task from its project on an empty project name", async () => {
      const repo = fakeRepo([{ projectId: "project-0", projectName: "Atlas" }]);

      const updated = await service(repo, fakeProjects(["Atlas"])).update(taskRef(repo.rows[0]!), {
        projectName: "  ",
      });

      expect(updated.projectId).toBeNull();
      expect(updated.projectName).toBeNull();
    });

    it("clears the due date when it is set to null", async () => {
      const repo = fakeRepo([{ dueAt: new Date("2026-09-04T21:59:59Z") }]);

      const updated = await service(repo).update(taskRef(repo.rows[0]!), { dueAt: null });

      expect(updated.dueAt).toBeNull();
    });

    it("clears the description on an empty string", async () => {
      const repo = fakeRepo([{ description: "old" }]);

      const updated = await service(repo).update(taskRef(repo.rows[0]!), { description: "  " });

      expect(updated.description).toBeNull();
    });

    it("refuses an update that changes nothing", async () => {
      const repo = fakeRepo([{ title: "prepare demo" }]);
      await expect(service(repo).update(taskRef(repo.rows[0]!), {})).rejects.toThrow(
        /Nothing to update/,
      );
    });
  });

  describe("list", () => {
    const mixed = () =>
      fakeRepo([
        { title: "A", status: "open" },
        { title: "B", status: "done", completedAt: EPOCH },
        { title: "C", status: "cancelled" },
      ]);

    it("shows only open tasks by default", async () => {
      // Cancelling is this project's soft delete, and a finished task is noise
      // in the answer to "what is left to do?".
      const tasks = await service(mixed()).list({ limit: 10 });
      expect(tasks.map((t) => t.title)).toEqual(["A"]);
    });

    it("returns finished tasks when they are asked for explicitly", async () => {
      const tasks = await service(mixed()).list({ status: "done", limit: 10 });
      expect(tasks.map((t) => t.title)).toEqual(["B"]);
    });

    it("narrows to one project", async () => {
      const repo = fakeRepo([
        { title: "A", projectId: "project-0" },
        { title: "B", projectId: null },
      ]);

      const tasks = await service(repo, fakeProjects(["Atlas"])).list({
        projectName: "atlas",
        limit: 10,
      });

      expect(tasks.map((t) => t.title)).toEqual(["A"]);
    });

    it("excludes undated tasks when a deadline bound is given", async () => {
      const repo = fakeRepo([
        { title: "dated", dueAt: new Date("2026-09-01T00:00:00Z") },
        { title: "undated", dueAt: null },
      ]);

      const tasks = await service(repo).list({
        dueBefore: new Date("2026-09-30T00:00:00Z"),
        limit: 10,
      });

      expect(tasks.map((t) => t.title)).toEqual(["dated"]);
    });

    it("honours the limit", async () => {
      expect(await service(mixed()).list({ status: "open", limit: 1 })).toHaveLength(1);
    });

    it("fails when the named project does not exist", async () => {
      await expect(service(fakeRepo()).list({ projectName: "Ghost", limit: 10 })).rejects.toThrow(
        NotFoundError,
      );
    });
  });
});
