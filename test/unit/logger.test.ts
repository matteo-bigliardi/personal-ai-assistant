import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/observability/logger.js";

/** Captures what the logger writes, without touching the real streams. */
function capture(run: (log: ReturnType<typeof createLogger>) => void): string {
  let output = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    run(createLogger("debug"));
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return output;
}

afterEach(() => vi.restoreAllMocks());

describe("logger redaction", () => {
  it("redacts secrets whatever the key is called", () => {
    // Exact-key matching used to let every one of these through.
    const output = capture((log) =>
      log.info("startup", {
        botToken: "12345:AAHsecret",
        TELEGRAM_BOT_TOKEN: "12345:AAHsecret",
        apiKey: "sk-ant-secret",
        Authorization: "Bearer secret",
        client_secret: "secret",
        googleCredentialFile: "secret.json",
      }),
    );

    expect(output).not.toContain("AAHsecret");
    expect(output).not.toContain("sk-ant");
    expect(output).not.toContain("Bearer");
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(6);
  });

  it("redacts nested and array values too", () => {
    const output = capture((log) =>
      log.info("config", { google: { apiKey: "sk-secret" }, headers: [{ token: "t-secret" }] }),
    );

    expect(output).not.toContain("secret");
  });

  it("leaves ordinary fields alone", () => {
    const output = capture((log) => log.info("tool.call", { tool: "create_task", latencyMs: 12 }));

    expect(output).toContain("create_task");
    expect(output).toContain("12");
  });

  it("honours the level threshold", () => {
    let output = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    createLogger("warn").info("quiet");
    spy.mockRestore();

    expect(output).toBe("");
  });
});
