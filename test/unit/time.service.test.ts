import { describe, expect, it } from "vitest";
import { createTimeService } from "../../src/domain/time/service.js";
import type {
  WorkSessionsRepository,
  WorkSessionWithProject,
} from "../../src/db/repositories/work-sessions.js";
import type { ProjectsService } from "../../src/domain/projects/service.js";
import type { Project, WorkSession } from "../../src/db/schema.js";
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
  PreconditionFailedError,
} from "../../src/domain/errors.js";

/**
 * The single-timer invariant is enforced by a partial unique index and proved
 * by the integration tests; here we exercise the rules the service owns — what
 * a second start says, what a zero-length interval says, which project statuses
 * accept new work, and how a period is turned into a half-open range.
 */

const ROME = "Europe/Rome";
const EPOCH = new Date("2026-08-01T00:00:00Z");

function fakeProjects(seed: { name: string; status?: Project["status"] }[]): ProjectsService {
  const rows: Project[] = seed.map((p, i) => ({
    id: `project-${i}`,
    name: p.name,
    description: null,
    status: p.status ?? "active",
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

function fakeRepo(seed: Partial<WorkSessionWithProject>[] = []): WorkSessionsRepository & {
  rows: WorkSessionWithProject[];
} {
  const rows: WorkSessionWithProject[] = seed.map((s, i) => ({
    id: s.id ?? `session-${i}`,
    projectId: s.projectId ?? "project-0",
    projectName: s.projectName ?? "Atlas",
    startedAt: s.startedAt ?? EPOCH,
    endedAt: s.endedAt ?? null,
    note: s.note ?? null,
  }));

  return {
    rows,
    async findActive() {
      return rows.find((r) => r.endedAt === null);
    },
    async start({ projectId, startedAt, note }) {
      const row: WorkSessionWithProject = {
        id: `session-${rows.length}`,
        projectId,
        projectName: "Atlas",
        startedAt,
        endedAt: null,
        note: note ?? null,
      };
      rows.push(row);
      return row;
    },
    async add({ projectId, startedAt, endedAt, note }) {
      const row: WorkSessionWithProject = {
        id: `session-${rows.length}`,
        projectId,
        projectName: "Atlas",
        startedAt,
        endedAt,
        note: note ?? null,
      };
      rows.push(row);
      return row;
    },
    async stop(id, endedAt) {
      const row = rows.find((r) => r.id === id && r.endedAt === null);
      if (!row) return undefined;
      row.endedAt = endedAt;
      return row as WorkSession;
    },
    async listOverlapping({ projectId, from, to }) {
      return rows.filter(
        (r) =>
          (!projectId || r.projectId === projectId) &&
          (!to || r.startedAt < to) &&
          (!from || r.endedAt === null || r.endedAt > from),
      );
    },
  };
}

const at = (iso: string) => new Date(iso);
const service = (
  repo: WorkSessionsRepository,
  projects: ProjectsService = fakeProjects([{ name: "Atlas" }]),
  now: Date = at("2026-08-31T10:00:00Z"),
) => createTimeService(repo, projects, ROME, () => now);

describe("time service", () => {
  describe("start", () => {
    it("starts a timer on a project", async () => {
      const repo = fakeRepo();
      const session = await service(repo).start("atlas");

      expect(session.projectId).toBe("project-0");
      expect(session.endedAt).toBeNull();
    });

    it("refuses a second timer and names the project already running", async () => {
      // Not a stop-and-switch: that would close a session the user never asked
      // to close. Naming the project lets the model offer the stop itself.
      const repo = fakeRepo([{ projectName: "Borealis" }]);

      await expect(service(repo).start("atlas")).rejects.toThrow(ConflictError);
      await expect(service(repo).start("atlas")).rejects.toThrow(/already running on "Borealis"/);
      expect(repo.rows).toHaveLength(1);
    });

    it("allows a timer on a paused project", async () => {
      // If you are working on it right now, it is not paused any more.
      const projects = fakeProjects([{ name: "Atlas", status: "paused" }]);
      const session = await service(fakeRepo(), projects).start("atlas");

      expect(session.endedAt).toBeNull();
    });

    it("refuses a timer on a completed or archived project", async () => {
      const completed = fakeProjects([{ name: "Atlas", status: "completed" }]);
      const archived = fakeProjects([{ name: "Atlas", status: "archived" }]);

      await expect(service(fakeRepo(), completed).start("atlas")).rejects.toThrow(
        PreconditionFailedError,
      );
      await expect(service(fakeRepo(), archived).start("atlas")).rejects.toThrow(/archived/);
    });

    it("fails when the project does not exist", async () => {
      await expect(service(fakeRepo()).start("Ghost")).rejects.toThrow(NotFoundError);
    });
  });

  describe("stop", () => {
    it("stops the running timer and reports its duration", async () => {
      const repo = fakeRepo([{ startedAt: at("2026-08-31T08:30:00Z") }]);
      const { seconds } = await service(repo).stop();

      expect(seconds).toBe(5400);
      expect(repo.rows[0]?.endedAt).toEqual(at("2026-08-31T10:00:00Z"));
    });

    it("fails when no timer is running", async () => {
      await expect(service(fakeRepo()).stop()).rejects.toThrow(PreconditionFailedError);
      await expect(service(fakeRepo()).stop()).rejects.toThrow(/No timer is running/);
    });

    it("explains a sub-second timer instead of letting the CHECK fire", async () => {
      // work_sessions_ended_after_started is a strict `>`. The refusal has to
      // arrive as something the user can act on, and waiting fixes it.
      const now = at("2026-08-31T10:00:00Z");
      const repo = fakeRepo([{ startedAt: now }]);

      const stopping = service(repo, fakeProjects([{ name: "Atlas" }]), now).stop();

      await expect(stopping).rejects.toThrow(InvalidInputError);
      await expect(stopping).rejects.toThrow(/less than a second/);
      expect(repo.rows[0]?.endedAt).toBeNull();
    });
  });

  describe("add", () => {
    it("records work that was already done", async () => {
      const session = await service(fakeRepo()).add({
        projectName: "atlas",
        startedAt: at("2026-08-30T08:00:00Z"),
        endedAt: at("2026-08-30T09:30:00Z"),
      });

      expect(session.endedAt).toEqual(at("2026-08-30T09:30:00Z"));
    });

    it("refuses a session with no duration", async () => {
      const instant = at("2026-08-30T08:00:00Z");

      await expect(
        service(fakeRepo()).add({ projectName: "atlas", startedAt: instant, endedAt: instant }),
      ).rejects.toThrow(/no duration/);
    });

    it("refuses a session that ends before it starts", async () => {
      await expect(
        service(fakeRepo()).add({
          projectName: "atlas",
          startedAt: at("2026-08-30T09:00:00Z"),
          endedAt: at("2026-08-30T08:00:00Z"),
        }),
      ).rejects.toThrow(/end before it started/);
    });

    it("refuses work on an archived project", async () => {
      const projects = fakeProjects([{ name: "Atlas", status: "archived" }]);

      await expect(
        service(fakeRepo(), projects).add({
          projectName: "atlas",
          startedAt: at("2026-08-30T08:00:00Z"),
          endedAt: at("2026-08-30T09:00:00Z"),
        }),
      ).rejects.toThrow(PreconditionFailedError);
    });
  });

  describe("report", () => {
    // Monday 2026-08-31, 12:00 in Rome.
    const now = at("2026-08-31T10:00:00Z");

    it("sums closed sessions across projects", async () => {
      const repo = fakeRepo([
        { startedAt: at("2026-08-31T08:00:00Z"), endedAt: at("2026-08-31T09:00:00Z") },
        {
          projectId: "project-1",
          projectName: "Borealis",
          startedAt: at("2026-08-31T09:00:00Z"),
          endedAt: at("2026-08-31T09:30:00Z"),
        },
      ]);

      const report = await service(repo, fakeProjects([{ name: "Atlas" }]), now).report({
        period: "today",
      });

      expect(report.totalSeconds).toBe(5400);
      // Ordered by size, so the model reads the dominant project first.
      expect(report.byProject).toEqual([
        { projectName: "Atlas", seconds: 3600 },
        { projectName: "Borealis", seconds: 1800 },
      ]);
    });

    it("counts a running timer up to now and flags it", async () => {
      const repo = fakeRepo([{ startedAt: at("2026-08-31T09:00:00Z") }]);

      const report = await service(repo, fakeProjects([{ name: "Atlas" }]), now).report({
        period: "today",
      });

      expect(report.totalSeconds).toBe(3600);
      expect(report.running?.projectName).toBe("Atlas");
      expect(report.running?.countedSeconds).toBe(3600);
    });

    it("clips a session at the edges of the period", async () => {
      // Started at 23:00 Rome yesterday, still running: only today's part counts.
      const repo = fakeRepo([{ startedAt: at("2026-08-30T21:00:00Z") }]);

      const report = await service(repo, fakeProjects([{ name: "Atlas" }]), now).report({
        period: "today",
      });

      // Local midnight was 2026-08-30T22:00Z, so twelve hours fall inside today.
      expect(report.totalSeconds).toBe(12 * 3600);
    });

    it("uses a week that starts on Monday", async () => {
      // Sunday 2026-08-30 belongs to the previous week, so it must not count.
      const repo = fakeRepo([
        { startedAt: at("2026-08-30T08:00:00Z"), endedAt: at("2026-08-30T09:00:00Z") },
        { startedAt: at("2026-08-31T08:00:00Z"), endedAt: at("2026-08-31T09:00:00Z") },
      ]);

      const report = await service(repo, fakeProjects([{ name: "Atlas" }]), now).report({
        period: "this_week",
      });

      expect(report.totalSeconds).toBe(3600);
    });

    it("includes the final day of an explicit range in full", async () => {
      // The bound is half-open, so a session late on the last day must count:
      // an inclusive 23:59:59 end would silently drop it.
      const repo = fakeRepo([
        { startedAt: at("2026-08-30T21:30:00Z"), endedAt: at("2026-08-30T21:59:59Z") },
      ]);

      const report = await service(repo, fakeProjects([{ name: "Atlas" }]), now).report({
        from: "2026-08-30",
        to: "2026-08-30",
      });

      expect(report.totalSeconds).toBe(1799);
    });

    it("counts everything when no period is given", async () => {
      const repo = fakeRepo([
        { startedAt: at("2020-01-01T08:00:00Z"), endedAt: at("2020-01-01T09:00:00Z") },
      ]);

      const report = await service(repo, fakeProjects([{ name: "Atlas" }]), now).report({});

      expect(report.totalSeconds).toBe(3600);
      expect(report.range.from).toBeUndefined();
    });

    it("narrows to one project", async () => {
      const repo = fakeRepo([
        { startedAt: at("2026-08-31T08:00:00Z"), endedAt: at("2026-08-31T09:00:00Z") },
        {
          projectId: "project-1",
          projectName: "Borealis",
          startedAt: at("2026-08-31T09:00:00Z"),
          endedAt: at("2026-08-31T09:30:00Z"),
        },
      ]);

      const report = await service(
        repo,
        fakeProjects([{ name: "Atlas" }, { name: "Borealis" }]),
        now,
      ).report({ projectName: "atlas", period: "today" });

      expect(report.totalSeconds).toBe(3600);
    });

    it("refuses a period and a date range at once", async () => {
      await expect(
        service(fakeRepo(), fakeProjects([{ name: "Atlas" }]), now).report({
          period: "today",
          from: "2026-08-01",
        }),
      ).rejects.toThrow(/not both/);
    });

    it("refuses a range that ends before it starts", async () => {
      await expect(
        service(fakeRepo(), fakeProjects([{ name: "Atlas" }]), now).report({
          from: "2026-08-31",
          to: "2026-08-01",
        }),
      ).rejects.toThrow(InvalidInputError);
    });
  });
});
