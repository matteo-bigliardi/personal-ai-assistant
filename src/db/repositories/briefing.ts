import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { briefingSettings, type BriefingSettings } from "../schema.js";

/**
 * Persistence for the briefing schedule and its once-a-day claim. SQL only:
 * what a valid time looks like, and what to do when the claim fails, are
 * decisions that live above this layer.
 */

export interface BriefingRepository {
  /** Reads the single row, creating it from `defaultSendAt` the first time. */
  ensure(defaultSendAt: string): Promise<BriefingSettings>;
  get(): Promise<BriefingSettings | undefined>;
  setSendAt(sendAt: string): Promise<BriefingSettings>;
  /**
   * Claims `localDate` for delivery. Returns false when it was already taken,
   * which is what makes a pg-boss retry a no-op rather than a second briefing.
   */
  claimDay(localDate: string): Promise<boolean>;
  /**
   * Puts the claim back, so a failed delivery can be retried. `previous` is
   * whatever the column held before the claim, null included.
   */
  releaseDay(previous: string | null): Promise<void>;
}

export function createBriefingRepository(db: Database): BriefingRepository {
  async function read(): Promise<BriefingSettings | undefined> {
    const [row] = await db.select().from(briefingSettings).limit(1);
    return row;
  }

  return {
    async ensure(defaultSendAt) {
      // The environment seeds the row and then stops mattering: after this the
      // database is the only place the schedule lives.
      await db
        .insert(briefingSettings)
        .values({ sendAt: defaultSendAt, updatedAt: new Date() })
        .onConflictDoNothing();
      const row = await read();
      if (!row) throw new Error("briefing settings row missing after insert");
      return row;
    },

    get: read,

    async setSendAt(sendAt) {
      const [row] = await db
        .update(briefingSettings)
        .set({ sendAt, updatedAt: new Date() })
        .returning();
      if (!row) throw new Error("briefing settings row missing");
      return row;
    },

    async claimDay(localDate) {
      // IS DISTINCT FROM, not <>: the column is null until the first briefing
      // ever sent, and a comparison with null would claim nothing at all.
      const rows = await db
        .update(briefingSettings)
        .set({ lastSentOn: localDate, updatedAt: new Date() })
        .where(sql`${briefingSettings.lastSentOn} IS DISTINCT FROM ${localDate}`)
        .returning({ id: briefingSettings.id });
      return rows.length > 0;
    },

    async releaseDay(previous) {
      await db.update(briefingSettings).set({ lastSentOn: previous, updatedAt: new Date() });
    },
  };
}
