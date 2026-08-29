import type { Logger } from "../../src/observability/logger.js";

export interface RecordedLog {
  level: string;
  msg: string;
  meta?: Record<string, unknown>;
}

export interface TestLogger extends Logger {
  records: RecordedLog[];
  find(msg: string): RecordedLog | undefined;
}

/** A logger that records instead of writing, so tests can assert on it. */
export function createTestLogger(): TestLogger {
  const records: RecordedLog[] = [];
  const push =
    (level: string) =>
    (msg: string, meta?: Record<string, unknown>): void => {
      records.push({ level, msg, ...(meta ? { meta } : {}) });
    };
  return {
    records,
    find: (msg) => records.find((r) => r.msg === msg),
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}
