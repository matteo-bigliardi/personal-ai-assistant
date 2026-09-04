import { z } from "zod";
import { isValidTimeZone } from "../domain/datetime.js";

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

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    HTTP_PORT: z.coerce.number().int().positive().default(3000),
    // Every relative date the assistant resolves depends on this, so an
    // unrecognised identifier must fail at startup, not at the first reminder.
    TZ: z
      .string()
      .default("Europe/Rome")
      .refine(isValidTimeZone, { message: "must be a valid IANA timezone, e.g. Europe/Rome" }),

    DATABASE_URL: z.url(),

    // The audit trail is the one table that grows with use rather than with
    // work, so it is kept on a window instead of forever.
    AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

    // Seeds the briefing schedule the first time the app starts and is ignored
    // ever after: the live value lives in the database, because the user
    // changes it by asking rather than by editing a file and restarting.
    BRIEFING_TIME: z
      .string()
      .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "must be a 24-hour time, e.g. 07:30")
      .default("07:30"),

    TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    TELEGRAM_ALLOWED_USER_IDS: csvNumbers,
    /**
     * Where the morning briefing goes. Deliberately not the first entry of the
     * allowlist: "who may talk to me" and "who I write to unprompted" are two
     * different questions, and tying them would let the order of a CSV decide
     * the second one. Without it the assistant runs, and simply never writes
     * first.
     */
    TELEGRAM_BRIEFING_CHAT_ID: z.string().min(1).optional(),

    ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
    ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),

    // Calendar is optional: without it the app runs with every other tool, and
    // the calendar tools are simply not registered. Half-configured is not a
    // state worth supporting, so the two must be given together.
    GOOGLE_SERVICE_ACCOUNT_KEY_FILE: z.string().min(1).optional(),
    /** The calendar to act on — the address it is shared with, not `primary`:
     *  a service account has a `primary` of its own, which is not yours. */
    GOOGLE_CALENDAR_ID: z.string().min(1).optional(),
  })
  .refine(
    (c) =>
      (c.GOOGLE_SERVICE_ACCOUNT_KEY_FILE === undefined) === (c.GOOGLE_CALENDAR_ID === undefined),
    {
      message: "set GOOGLE_SERVICE_ACCOUNT_KEY_FILE and GOOGLE_CALENDAR_ID together, or neither",
      path: ["GOOGLE_CALENDAR_ID"],
    },
  );

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
