/**
 * Minimal structured (JSON) logger with basic secret redaction.
 * Kept dependency-free to stay simple; can be swapped for pino later without
 * touching call sites.
 */
type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEYS = [
  "token",
  "apikey",
  "api_key",
  "authorization",
  "password",
  "secret",
  "client_secret",
];

function redact(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_KEYS.includes(k.toLowerCase())) out[k] = "[REDACTED]";
    else out[k] = redact(v);
  }
  return out;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(minLevel: Level = "info"): Logger {
  const threshold = LEVELS[minLevel];
  const emit = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS[level] < threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(meta ? (redact(meta) as Record<string, unknown>) : {}),
    };
    const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
    out.write(JSON.stringify(line) + "\n");
  };
  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}
