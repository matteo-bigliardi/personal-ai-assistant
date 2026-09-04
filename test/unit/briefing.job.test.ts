import { describe, expect, it } from "vitest";
import { createBriefingWriter } from "../../src/agent/briefing.js";
import type { LlmProvider } from "../../src/agent/providers/types.js";
import type { BriefingRepository } from "../../src/db/repositories/briefing.js";
import type { BriefingSettings } from "../../src/db/schema.js";
import type { BriefingData, BriefingService } from "../../src/domain/briefing/service.js";
import { createBriefingJob, cronFor } from "../../src/jobs/briefing.js";
import { createTestLogger } from "../helpers/logger.js";

const TZ = "Europe/Rome";
/** Wednesday, 07:30 local. */
const NOW = new Date("2026-09-09T05:30:00Z");

const DATA: BriefingData = {
  date: "2026-09-09",
  events: [{ summary: "revisione", allDay: false, start: "08:00", end: "09:00" }],
  tasks: [],
  empty: false,
  calendarUnavailable: false,
};

function fakeRepo(lastSentOn: string | null = null) {
  const row: BriefingSettings = { id: true, sendAt: "07:30", lastSentOn, updatedAt: NOW };
  const repo: BriefingRepository = {
    async ensure() {
      return row;
    },
    async get() {
      return row;
    },
    async setSendAt(sendAt) {
      row.sendAt = sendAt;
      return row;
    },
    async claimDay(localDate) {
      if (row.lastSentOn === localDate) return false;
      row.lastSentOn = localDate;
      return true;
    },
    async releaseDay(previous) {
      row.lastSentOn = previous;
    },
  };
  return { repo, row };
}

const service = {
  async collect() {
    return DATA;
  },
} as unknown as BriefingService;

function jobWith(opts: { repo: BriefingRepository; failDelivery?: boolean }) {
  const sent: string[] = [];
  const job = createBriefingJob({
    boss: {} as never, // `run` never touches the queue.
    repo: opts.repo,
    service,
    writer: {
      async write() {
        return "buongiorno";
      },
    },
    delivery: {
      async deliver({ text }) {
        if (opts.failDelivery) throw new Error("telegram is down");
        sent.push(text);
      },
    },
    chatId: "chat-1",
    timeZone: TZ,
    logger: createTestLogger(),
    now: () => NOW,
  });
  return { job, sent };
}

describe("cronFor", () => {
  it("turns a wall-clock time into a daily cron", () => {
    expect(cronFor("07:30")).toBe("30 7 * * *");
    expect(cronFor("00:05")).toBe("5 0 * * *");
    expect(cronFor("23:59")).toBe("59 23 * * *");
  });
});

describe("briefing delivery", () => {
  it("sends the briefing and claims the day", async () => {
    const { repo, row } = fakeRepo();
    const { job, sent } = jobWith({ repo });

    await expect(job.run()).resolves.toBe(true);

    expect(sent).toEqual(["buongiorno"]);
    expect(row.lastSentOn).toBe("2026-09-09");
  });

  it("does not send a second briefing on the same day", async () => {
    const { repo } = fakeRepo("2026-09-09");
    const { job, sent } = jobWith({ repo });

    await expect(job.run()).resolves.toBe(false);

    expect(sent).toEqual([]);
  });

  it("releases the day when the send fails, so the retry can work", async () => {
    // Claiming and never letting go would lose a whole morning to one blip.
    const { repo, row } = fakeRepo();
    const { job } = jobWith({ repo, failDelivery: true });

    await expect(job.run()).rejects.toThrow("telegram is down");

    expect(row.lastSentOn).toBeNull();
  });

  it("runs forced without consuming the real briefing", async () => {
    const { repo, row } = fakeRepo();
    const { job, sent } = jobWith({ repo });

    await expect(job.run({ force: true })).resolves.toBe(true);

    expect(sent).toEqual(["buongiorno"]);
    // The day is still unclaimed: the smoke script must not eat the morning.
    expect(row.lastSentOn).toBeNull();
  });
});

/** Replays one canned provider response. */
function fakeProvider(text: string | Error): LlmProvider {
  return {
    async run() {
      if (text instanceof Error) throw text;
      return { text, toolCalls: [], latencyMs: 1 };
    },
  };
}

describe("briefing writer", () => {
  it("asks the model without any tools at all", async () => {
    const calls: unknown[] = [];
    const provider: LlmProvider = {
      async run(input) {
        calls.push(input.tools);
        return { text: "buongiorno", toolCalls: [], latencyMs: 1 };
      },
    };

    const text = await createBriefingWriter({ provider, logger: createTestLogger() }).write(DATA);

    expect(text).toBe("buongiorno");
    expect(calls).toEqual([[]]);
  });

  it("falls back to text written without a model when the provider fails", async () => {
    const logger = createTestLogger();
    const writer = createBriefingWriter({ provider: fakeProvider(new Error("429")), logger });

    const text = await writer.write(DATA);

    expect(text).toContain("revisione");
    expect(logger.find("briefing.write_failed")).toBeDefined();
  });

  it("falls back when the model answers with nothing", async () => {
    const writer = createBriefingWriter({
      provider: fakeProvider("   "),
      logger: createTestLogger(),
    });

    expect(await writer.write(DATA)).toContain("revisione");
  });
});
