import { describe, expect, it, vi } from "vitest";
import type { AuditRepository } from "../../src/db/repositories/audit.js";
import { createAuditRetention } from "../../src/jobs/audit-retention.js";
import { createTestLogger } from "../helpers/logger.js";

const NOW = new Date("2026-09-04T10:00:00Z");

function fakeRepo(fail = false) {
  const cutoffs: Date[] = [];
  const repo: AuditRepository = {
    async record() {},
    async list() {
      return [];
    },
    async deleteOlderThan(cutoff) {
      if (fail) throw new Error("relation audit_events does not exist");
      cutoffs.push(cutoff);
      return 3;
    },
  };
  return { repo, cutoffs };
}

describe("audit retention", () => {
  it("drops everything older than the window", async () => {
    const { repo, cutoffs } = fakeRepo();
    const retention = createAuditRetention({
      repo,
      logger: createTestLogger(),
      retentionDays: 90,
      now: () => NOW,
    });

    await expect(retention.sweep()).resolves.toBe(3);
    expect(cutoffs[0]?.toISOString()).toBe("2026-06-06T10:00:00.000Z");
  });

  it("logs and survives a failing sweep", async () => {
    const { repo } = fakeRepo(true);
    const logger = createTestLogger();
    const retention = createAuditRetention({
      repo,
      logger,
      retentionDays: 90,
      now: () => NOW,
    });

    await expect(retention.sweep()).resolves.toBe(0);
    expect(logger.find("audit.retention_failed")).toBeDefined();
  });

  it("sweeps once on start, so a restart is not a free pass", async () => {
    const { repo, cutoffs } = fakeRepo();
    const retention = createAuditRetention({
      repo,
      logger: createTestLogger(),
      retentionDays: 90,
      now: () => NOW,
    });

    retention.start();
    await vi.waitFor(() => expect(cutoffs).toHaveLength(1));
    retention.stop();
  });
});
