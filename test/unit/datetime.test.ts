import { describe, expect, it } from "vitest";
import {
  endOfDay,
  formatHuman,
  formatInstant,
  formatNowBlock,
  isValidTimeZone,
  parseDueAt,
  parseInstant,
  startOfDay,
  startOfMonth,
  startOfWeek,
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

/**
 * Period boundaries are shared ground: task deadlines need the end of a day,
 * and time reporting needs the start of a day, week and month. Every case here
 * is stated as the instant a clock in Rome shows, because that is the only
 * thing the user ever means.
 */
describe("period boundaries", () => {
  it("opens the day at local midnight", () => {
    const midday = new Date("2026-08-29T10:00:00Z"); // 12:00 in Rome
    expect(formatInstant(startOfDay(midday, ROME), ROME)).toBe("2026-08-29T00:00:00+02:00");
  });

  it("closes the day at the last local second", () => {
    const midday = new Date("2026-08-29T10:00:00Z");
    expect(formatInstant(endOfDay(midday, ROME), ROME)).toBe("2026-08-29T23:59:59+02:00");
  });

  it("uses the local day, not the UTC one", () => {
    // 23:30 UTC is already the next day in Rome, and the boundary follows Rome.
    const lateEvening = new Date("2026-08-29T23:30:00Z");
    expect(formatInstant(startOfDay(lateEvening, ROME), ROME)).toBe("2026-08-30T00:00:00+02:00");
  });

  it("opens the week on Monday", () => {
    const sunday = new Date("2026-08-30T10:00:00Z");
    const monday = new Date("2026-08-31T10:00:00Z");

    // Italy starts the week on Monday, so Sunday belongs to the week before.
    expect(formatInstant(startOfWeek(sunday, ROME), ROME)).toBe("2026-08-24T00:00:00+02:00");
    expect(formatInstant(startOfWeek(monday, ROME), ROME)).toBe("2026-08-31T00:00:00+02:00");
  });

  it("opens the week correctly when it spans a month boundary", () => {
    const wednesday = new Date("2026-09-02T10:00:00Z");
    expect(formatInstant(startOfWeek(wednesday, ROME), ROME)).toBe("2026-08-31T00:00:00+02:00");
  });

  it("opens the month on the first", () => {
    const midMonth = new Date("2026-08-29T10:00:00Z");
    expect(formatInstant(startOfMonth(midMonth, ROME), ROME)).toBe("2026-08-01T00:00:00+02:00");
  });

  it("picks the offset in force on the day itself, not today's", () => {
    // Rome is on CET in January and CEST in August: a boundary computed with a
    // single fixed offset would be an hour out for half the year.
    const winter = new Date("2026-01-15T12:00:00Z");
    expect(formatInstant(startOfDay(winter, ROME), ROME)).toBe("2026-01-15T00:00:00+01:00");
    expect(formatInstant(endOfDay(winter, ROME), ROME)).toBe("2026-01-15T23:59:59+01:00");
  });

  it("handles the day that loses an hour", () => {
    // Rome enters CEST on 2026-03-29: that day is 23 hours long and starts at
    // 00:00 CET, an hour earlier in UTC terms than a normal summer day.
    const springForward = new Date("2026-03-29T12:00:00Z");
    const start = startOfDay(springForward, ROME);

    expect(formatInstant(start, ROME)).toBe("2026-03-29T00:00:00+01:00");
    expect(start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(formatInstant(endOfDay(springForward, ROME), ROME)).toBe("2026-03-29T23:59:59+02:00");
  });

  it("handles the day that repeats an hour", () => {
    // Rome leaves CEST on 2026-10-25: 25 hours long, opening on CEST.
    const fallBack = new Date("2026-10-25T12:00:00Z");
    expect(formatInstant(startOfDay(fallBack, ROME), ROME)).toBe("2026-10-25T00:00:00+02:00");
    expect(formatInstant(endOfDay(fallBack, ROME), ROME)).toBe("2026-10-25T23:59:59+01:00");
  });
});

describe("parseDueAt", () => {
  it("reads a bare date as the end of that day in the local zone", () => {
    // "by Friday" is due at the end of Friday: a task due Friday must not be
    // reported as overdue on Friday morning.
    const due = parseDueAt("2026-09-04", ROME, new Date("2026-08-31T10:00:00Z"));
    expect(formatInstant(due, ROME)).toBe("2026-09-04T23:59:59+02:00");
  });

  it("uses the offset of the due date, not of today", () => {
    const due = parseDueAt("2026-12-04", ROME, new Date("2026-08-31T10:00:00Z"));
    expect(formatInstant(due, ROME)).toBe("2026-12-04T23:59:59+01:00");
  });

  it("keeps an explicit instant exactly as given", () => {
    const due = parseDueAt("2026-09-04T15:00:00+02:00", ROME, new Date("2026-08-31T10:00:00Z"));
    expect(formatInstant(due, ROME)).toBe("2026-09-04T15:00:00+02:00");
  });

  it("rejects a date that does not exist", () => {
    expect(() => parseDueAt("2026-02-30", ROME)).toThrow(InvalidInputError);
    expect(() => parseDueAt("2026-13-01", ROME)).toThrow(/real calendar date/);
  });

  it("still rejects a local time with no offset", () => {
    expect(() => parseDueAt("2026-09-04T15:00", ROME)).toThrow(InvalidInputError);
  });

  it("rejects a date outside the supported range", () => {
    expect(() => parseDueAt("1998-09-04", ROME)).toThrow(/supported range/);
  });
});
