import { z } from "zod";

/**
 * Typed, validated configuration loaded once at startup from environment variables.
 * The app must fail fast if required config is missing or malformed.
 */
const csvNumbers = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
      .map((x) => Number(x)),
  )
  .pipe(z.array(z.number().int().positive()));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  HTTP_PORT: z.coerce.number().int().positive().default(3000),
  TZ: z.string().default("Europe/Rome"),

  DATABASE_URL: z.string().url(),

  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_USER_IDS: csvNumbers,

  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function loadConfig(env?: NodeJS.ProcessEnv): Config {
  // Only the process-wide config (read from process.env) is cached. When an
  // explicit env is passed (tests) we always parse fresh.
  const useCache = env === undefined;
  if (useCache && cached) return cached;

  const parsed = schema.safeParse(env ?? process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  if (useCache) cached = parsed.data;
  return parsed.data;
}
