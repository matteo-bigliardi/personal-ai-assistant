import { describe, expect, it } from "vitest";
import {
  formatHuman,
  formatInstant,
  formatNowBlock,
  isValidTimeZone,
  parseInstant,
} from "../../src/domain/datetime.js";
import { InvalidInputError } from "../../src/domain/errors.js";

const ROME = "Europe/Rome";

describe("formatInstant", () => {
  it("renders an instant in the target zone with its offset", () => {
    const summer = new Date("2026-08-29T12:37:00Z");
    expect(formatInstant(summer, ROME)).toBe("2026-08-29T14:37:00+02:00");
  });

  it("follows the daylight-saving offset", () => {
    const winter = new Date("2026-01-15T12:00:00Z");
    expect(formatInstant(winter, ROME)).toBe("2026-01-15T13:00:00+01:00");
  });

  it("renders UTC without an offset name", () => {
    expect(formatInstant(new Date("2026-08-29T12:37:00Z"), "UTC")).toBe(
      "2026-08-29T12:37:00+00:00",
    );
  });
});

describe("formatHuman", () => {
  it("names the weekday in the target zone", () => {
    expect(formatHuman(new Date("2026-08-29T12:37:00Z"), ROME)).toBe("Saturday 2026-08-29 14:37");
  });
});

describe("parseInstant", () => {
  const now = new Date("2026-08-29T12:00:00Z");

  it("accepts an offset instant", () => {
    expect(parseInstant("2026-08-29T15:00:00+02:00", now).toISOString()).toBe(
      "2026-08-29T13:00:00.000Z",
    );
  });

  it("accepts Z and omitted seconds", () => {
    expect(parseInstant("2026-08-29T13:00Z", now).toISOString()).toBe("2026-08-29T13:00:00.000Z");
  });

  it.each([
    ["a local time without an offset", "2026-08-29T15:00:00"],
    ["a date without a time", "2026-08-29"],
    ["free text", "next friday"],
    ["an empty string", ""],
  ])("rejects %s", (_label, value) => {
    expect(() => parseInstant(value, now)).toThrow(InvalidInputError);
  });

  it("rejects a non-string", () => {
    expect(() => parseInstant(1756468800000, now)).toThrow(InvalidInputError);
  });

  it("rejects a date that does not exist instead of rolling it over", () => {
    // new Date("2026-02-30") would silently become March 2nd.
    expect(() => parseInstant("2026-02-30T10:00:00Z", now)).toThrow(/not a real calendar date/);
  });

  it("accepts February 29th on a leap year", () => {
    expect(parseInstant("2028-02-29T10:00:00Z", now)).toBeInstanceOf(Date);
  });

  it("rejects instants outside the supported range", () => {
    expect(() => parseInstant("1999-12-31T23:59:59Z", now)).toThrow(/supported range/);
    expect(() => parseInstant("2999-01-01T00:00:00Z", now)).toThrow(/supported range/);
  });
});

describe("formatNowBlock", () => {
  it("states the current instant and weekday", () => {
    const block = formatNowBlock(new Date("2026-08-29T12:37:00Z"), ROME);
    expect(block).toContain("2026-08-29T14:37:00+02:00");
    expect(block).toContain("(Saturday)");
    expect(block).toContain(ROME);
  });

  it("lists seven distinct consecutive days", () => {
    const block = formatNowBlock(new Date("2026-08-29T12:37:00Z"), ROME);
    expect(block).toContain("today Sat 2026-08-29");
    expect(block).toContain("Fri 2026-09-04");
    const dates = [...block.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]);
    // Seven calendar days, all different; "today" repeats the current date.
    expect(new Set(dates).size).toBe(7);
  });

  it("does not repeat a date across a daylight-saving transition", () => {
    // Rome leaves CEST on 2026-10-25: that civil day is 25 hours long, so
    // adding fixed 24h blocks would emit the same date twice.
    const block = formatNowBlock(new Date("2026-10-24T22:00:00Z"), ROME);
    expect(block).toContain("today Sun 2026-10-25");
    expect(block).toContain("Mon 2026-10-26");
    const dates = [...block.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]);
    expect(new Set(dates.slice(1)).size).toBe(7);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA identifiers and rejects anything else", () => {
    expect(isValidTimeZone(ROME)).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
