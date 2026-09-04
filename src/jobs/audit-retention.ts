import type { AuditRepository } from "../db/repositories/audit.js";
import type { Logger } from "../observability/logger.js";

/**
 * Retention sweep for the audit trail.
 *
 * `audit_events` is the only table here that grows with use rather than with
 * work: one row per tool call, forever. A window keeps it bounded, and keeps a
 * database dump from carrying years of activity nobody will ever read.
 *
 * Deliberately not a pg-boss job, unlike reminder delivery. A reminder must
 * survive a restart because a missed one is a promise broken to the user; a
 * missed sweep is invisible, because the next one deletes by cutoff and catches
 * up on its own. Durability, retries and idempotency would all be machinery
 * around an operation that is already idempotent and already unimportant.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuditRetentionOptions {
  repo: AuditRepository;
  logger: Logger;
  /** Rows older than this are dropped. */
  retentionDays: number;
  /** How often the sweep runs. Daily by default. */
  intervalMs?: number;
  now?: () => Date;
}

export interface AuditRetention {
  /** Runs one sweep. Never throws: retention must not take the app down. */
  sweep(): Promise<number>;
  start(): void;
  stop(): void;
}

export function createAuditRetention(opts: AuditRetentionOptions): AuditRetention {
  const { repo, logger, retentionDays } = opts;
  const intervalMs = opts.intervalMs ?? DAY_MS;
  const clock = opts.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;

  async function sweep(): Promise<number> {
    const cutoff = new Date(clock().getTime() - retentionDays * DAY_MS);
    try {
      const deleted = await repo.deleteOlderThan(cutoff);
      if (deleted > 0) {
        logger.info("audit.retention", { deleted, cutoff: cutoff.toISOString(), retentionDays });
      }
      return deleted;
    } catch (err) {
      logger.error("audit.retention_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  return {
    sweep,

    start() {
      if (timer) return;
      void sweep();
      timer = setInterval(() => void sweep(), intervalMs);
      // The sweep is never a reason to keep the process alive.
      timer.unref();
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
