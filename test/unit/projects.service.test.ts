import { describe, expect, it } from "vitest";
import { createProjectsService } from "../../src/domain/projects/service.js";
import type { ProjectsRepository, UpdateProjectInput } from "../../src/db/repositories/projects.js";
import type { Project } from "../../src/db/schema.js";
import { InvalidInputError, NotFoundError } from "../../src/domain/errors.js";

/**
 * In-memory stand-in for the repository. Uniqueness is enforced by the database
 * in production and is covered by the integration tests; here we only exercise
 * the rules the service itself owns.
 */
function fakeRepo(seed: Partial<Project>[] = []): ProjectsRepository & { rows: Project[] } {
  const rows: Project[] = seed.map((p, i) => ({
    id: `id-${i}`,
    name: p.name ?? `project-${i}`,
    description: p.description ?? null,
    status: p.status ?? "active",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
  }));

  return {
    rows,
    async create({ name, description }) {
      const row: Project = {
        id: `id-${rows.length}`,
        name,
        description: description ?? null,
        status: "active",
        createdAt: new Date("2026-08-29T00:00:00Z"),
        updatedAt: new Date("2026-08-29T00:00:00Z"),
      };
      rows.push(row);
      return row;
    },
    async list({ statuses, limit }) {
      return rows.filter((r) => !statuses?.length || statuses.includes(r.status)).slice(0, limit);
    },
    async findByName(name) {
      return rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
    },
    async findById(id) {
      return rows.find((r) => r.id === id);
    },
    async update(id, patch: UpdateProjectInput) {
      const row = rows.find((r) => r.id === id);
      if (!row) return undefined;
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.description !== undefined) row.description = patch.description;
      if (patch.status !== undefined) row.status = patch.status;
      return row;
    },
  };
}

describe("projects service", () => {
  describe("create", () => {
    it("trims and collapses whitespace in the name", async () => {
      const repo = fakeRepo();
      const project = await createProjectsService(repo).create({ name: "  Atlas   Prime " });
      expect(project.name).toBe("Atlas Prime");
    });

    it("rejects an empty name", async () => {
      await expect(createProjectsService(fakeRepo()).create({ name: "   " })).rejects.toThrow(
        InvalidInputError,
      );
    });

    it("rejects an over-long name", async () => {
      await expect(
        createProjectsService(fakeRepo()).create({ name: "x".repeat(81) }),
      ).rejects.toThrow(/80 characters/);
    });

    it("rejects an over-long description", async () => {
      await expect(
        createProjectsService(fakeRepo()).create({ name: "Atlas", description: "x".repeat(501) }),
      ).rejects.toThrow(/500 characters/);
    });
  });

  describe("getByName", () => {
    it("resolves regardless of casing", async () => {
      const service = createProjectsService(fakeRepo([{ name: "Atlas" }]));
      expect((await service.getByName("aTLaS")).name).toBe("Atlas");
    });

    it("reports a missing project by name", async () => {
      const service = createProjectsService(fakeRepo());
      await expect(service.getByName("Atlas")).rejects.toThrow(NotFoundError);
      await expect(service.getByName("Atlas")).rejects.toThrow(/No project named "Atlas"/);
    });
  });

  describe("update", () => {
    it("renames and normalises", async () => {
      const service = createProjectsService(fakeRepo([{ name: "Atlas" }]));
      const updated = await service.update("atlas", { newName: "  Atlas  Two " });
      expect(updated.name).toBe("Atlas Two");
    });

    it("changes status", async () => {
      const service = createProjectsService(fakeRepo([{ name: "Atlas" }]));
      expect((await service.update("Atlas", { status: "archived" })).status).toBe("archived");
    });

    it("clears the description on an empty string", async () => {
      const service = createProjectsService(fakeRepo([{ name: "Atlas", description: "old" }]));
      expect((await service.update("Atlas", { description: "  " })).description).toBeNull();
    });

    it("refuses an update that changes nothing", async () => {
      const service = createProjectsService(fakeRepo([{ name: "Atlas" }]));
      await expect(service.update("Atlas", {})).rejects.toThrow(/Nothing to update/);
    });

    it("fails when the project does not exist", async () => {
      const service = createProjectsService(fakeRepo());
      await expect(service.update("Ghost", { status: "paused" })).rejects.toThrow(NotFoundError);
    });
  });

  describe("list", () => {
    const mixed = () =>
      fakeRepo([
        { name: "A", status: "active" },
        { name: "B", status: "archived" },
        { name: "C", status: "paused" },
        { name: "D", status: "completed" },
      ]);

    it("hides archived projects by default", async () => {
      const projects = await createProjectsService(mixed()).list({ limit: 10 });

      // Archiving is this project's soft delete; pausing is not.
      expect(projects.map((p) => p.name)).toEqual(["A", "C", "D"]);
    });

    it("returns archived projects when they are asked for explicitly", async () => {
      const projects = await createProjectsService(mixed()).list({
        status: "archived",
        limit: 10,
      });

      expect(projects.map((p) => p.name)).toEqual(["B"]);
    });

    it("narrows to a single status when one is given", async () => {
      const projects = await createProjectsService(mixed()).list({ status: "paused", limit: 10 });

      expect(projects.map((p) => p.name)).toEqual(["C"]);
    });

    it("honours the limit", async () => {
      expect(await createProjectsService(mixed()).list({ limit: 1 })).toHaveLength(1);
    });
  });
});
