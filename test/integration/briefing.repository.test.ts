import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createBriefingRepository,
  type BriefingRepository,
} from "../../src/db/repositories/briefing.js";
import { setupTestDb } from "./helpers/db.js";

/**
 * Against a real Postgres because the guarantees under test are the database's:
 * the single-row CHECK, the time format CHECK, and above all the conditional
 * claim, which is what stops a retried job from sending a second briefing.
 */
const testDb = await setupTestDb();
const describeDb = testDb ? describe : describe.skip;

if (!testDb) {
  console.warn("[integration] no Postgres reachable — skipping briefing repository tests");
}

describeDb("briefing repository", () => {
  let repo: BriefingRepository;

  beforeEach(async () => {
    await testDb?.truncate();
    if (testDb) repo = createBriefingRepository(testDb.db);
  });

  afterAll(async () => {
    await testDb?.close();
  });

  it("seeds the row once and leaves it alone afterwards", async () => {
    const first = await repo.ensure("07:30");
    const second = await repo.ensure("09:00");

    expect(first.sendAt).toBe("07:30");
    // The environment seeds the schedule; it does not keep overwriting it.
    expect(second.sendAt).toBe("07:30");
  });

  it("keeps exactly one row", async () => {
    await repo.ensure("07:30");
    await repo.ensure("07:30");

    const rows = await testDb!.pool.query("SELECT count(*)::int AS n FROM briefing_settings");
    expect(rows.rows[0]?.n).toBe(1);
  });

  it("refuses a malformed time at the database level", async () => {
    await repo.ensure("07:30");

    await expect(
      testDb!.pool.query("UPDATE briefing_settings SET send_at = '25:00'"),
    ).rejects.toThrow(/briefing_settings_send_at_format/);
  });

  it("claims a day once and only once", async () => {
    await repo.ensure("07:30");

    expect(await repo.claimDay("2026-09-09")).toBe(true);
    // The second attempt is the retried job: it must find the day taken.
    expect(await repo.claimDay("2026-09-09")).toBe(false);
    expect(await repo.claimDay("2026-09-10")).toBe(true);
  });

  it("lets a claim be given back so a failed send can be retried", async () => {
    await repo.ensure("07:30");
    await repo.claimDay("2026-09-09");

    await repo.releaseDay(null);

    expect(await repo.claimDay("2026-09-09")).toBe(true);
  });

  it("stores a new time", async () => {
    await repo.ensure("07:30");

    const updated = await repo.setSendAt("08:05");

    expect(updated.sendAt).toBe("08:05");
    expect((await repo.get())?.sendAt).toBe("08:05");
  });
});
