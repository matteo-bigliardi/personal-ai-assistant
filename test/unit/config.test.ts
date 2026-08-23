import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  TELEGRAM_BOT_TOKEN: "token",
  ANTHROPIC_API_KEY: "key",
};

describe("loadConfig", () => {
  it("parses a minimal valid environment with defaults", () => {
    const cfg = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(cfg.TZ).toBe("Europe/Rome");
    expect(cfg.HTTP_PORT).toBe(3000);
    expect(cfg.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
  });

  it("parses the allowlist CSV into positive integers", () => {
    const cfg = loadConfig({
      ...base,
      TELEGRAM_ALLOWED_USER_IDS: " 111, 222 ,333 ",
    } as NodeJS.ProcessEnv);
    expect(cfg.TELEGRAM_ALLOWED_USER_IDS).toEqual([111, 222, 333]);
  });

  it("throws when a required variable is missing", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: base.DATABASE_URL } as NodeJS.ProcessEnv),
    ).toThrow(/Invalid configuration/);
  });
});
