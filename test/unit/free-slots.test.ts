import { describe, expect, it } from "vitest";
import { findFreeSlots, mergeIntervals } from "../../src/domain/calendar/free-slots.js";
import { InvalidInputError } from "../../src/domain/errors.js";

/**
 * Free-slot maths is where a calendar assistant is most likely to be quietly
 * wrong: overlapping meetings, one event swallowing another, back-to-back
 * bookings, and events that reach in from outside the window. None of that
 * needs a Google account to pin down, so none of it is left to a live test.
 */

const at = (hhmm: string) => new Date(`2026-09-02T${hhmm}:00Z`);
const iv = (start: string, end: string) => ({ start: at(start), end: at(end) });
const show = (slots: { start: Date; end: Date }[]) =>
  slots.map((s) => `${s.start.toISOString().slice(11, 16)}-${s.end.toISOString().slice(11, 16)}`);

const WINDOW = iv("09:00", "18:00");
const find = (busy: { start: Date; end: Date }[], minimumMinutes = 60, limit = 10) =>
  findFreeSlots({ window: WINDOW, busy, minimumMinutes, limit });

describe("mergeIntervals", () => {
  it("merges overlapping intervals", () => {
    expect(show(mergeIntervals([iv("09:00", "11:00"), iv("10:00", "12:00")]))).toEqual([
      "09:00-12:00",
    ]);
  });

  it("merges intervals that merely touch", () => {
    // Two meetings ending and starting at 11:00 leave no gap between them.
    expect(show(mergeIntervals([iv("09:00", "11:00"), iv("11:00", "12:00")]))).toEqual([
      "09:00-12:00",
    ]);
  });

  it("absorbs an interval fully inside another", () => {
    expect(show(mergeIntervals([iv("09:00", "17:00"), iv("11:00", "12:00")]))).toEqual([
      "09:00-17:00",
    ]);
  });

  it("sorts before merging, so input order does not matter", () => {
    expect(show(mergeIntervals([iv("14:00", "15:00"), iv("09:00", "10:00")]))).toEqual([
      "09:00-10:00",
      "14:00-15:00",
    ]);
  });

  it("drops zero-length intervals", () => {
    expect(mergeIntervals([iv("09:00", "09:00")])).toEqual([]);
  });
});

describe("findFreeSlots", () => {
  it("returns the whole window when nothing is booked", () => {
    expect(show(find([]))).toEqual(["09:00-18:00"]);
  });

  it("returns the gaps around a single meeting", () => {
    expect(show(find([iv("12:00", "13:00")]))).toEqual(["09:00-12:00", "13:00-18:00"]);
  });

  it("ignores gaps shorter than the minimum", () => {
    // The 30 minutes between the two meetings is not an hour.
    expect(show(find([iv("11:00", "12:00"), iv("12:30", "14:00")]))).toEqual([
      "09:00-11:00",
      "14:00-18:00",
    ]);
  });

  it("counts a gap exactly as long as the minimum", () => {
    expect(show(find([iv("11:00", "12:00"), iv("13:00", "14:00")]))).toContain("12:00-13:00");
  });

  it("handles overlapping meetings without inventing a gap between them", () => {
    expect(show(find([iv("11:00", "13:00"), iv("12:00", "14:00")]))).toEqual([
      "09:00-11:00",
      "14:00-18:00",
    ]);
  });

  it("handles a meeting that swallows another", () => {
    expect(show(find([iv("10:00", "16:00"), iv("12:00", "13:00")]))).toEqual([
      "09:00-10:00",
      "16:00-18:00",
    ]);
  });

  it("clips an event that starts before the window", () => {
    // A meeting running 08:00-10:00 eats the first hour and nothing before it.
    expect(show(find([iv("08:00", "10:00")]))).toEqual(["10:00-18:00"]);
  });

  it("clips an event that ends after the window", () => {
    expect(show(find([iv("17:00", "20:00")]))).toEqual(["09:00-17:00"]);
  });

  it("ignores events entirely outside the window", () => {
    expect(show(find([iv("06:00", "07:00"), iv("19:00", "20:00")]))).toEqual(["09:00-18:00"]);
  });

  it("returns nothing when the window is fully booked", () => {
    expect(find([iv("08:00", "19:00")])).toEqual([]);
  });

  it("returns nothing when every gap is too short", () => {
    expect(find([iv("09:30", "17:30")], 60)).toEqual([]);
  });

  it("honours the limit, keeping the soonest slots", () => {
    const busy = [iv("11:00", "12:00"), iv("14:00", "15:00")];
    expect(show(find(busy, 60, 2))).toEqual(["09:00-11:00", "12:00-14:00"]);
  });

  it("rejects a window that ends before it starts", () => {
    expect(() =>
      findFreeSlots({ window: iv("18:00", "09:00"), busy: [], minimumMinutes: 60, limit: 5 }),
    ).toThrow(InvalidInputError);
  });

  it("rejects a nonsensical minimum", () => {
    expect(() =>
      findFreeSlots({ window: WINDOW, busy: [], minimumMinutes: 0, limit: 5 }),
    ).toThrow(InvalidInputError);
    expect(() =>
      findFreeSlots({ window: WINDOW, busy: [], minimumMinutes: 1.5, limit: 5 }),
    ).toThrow(/whole number/);
  });
});
