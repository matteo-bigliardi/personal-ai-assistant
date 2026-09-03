import { InvalidInputError } from "../errors.js";

/**
 * Finding free time.
 *
 * Deliberately pure: it takes busy intervals and gives back gaps, with no
 * knowledge of Google, of the model or of how the events were fetched. That is
 * what makes the hard part — overlaps, containment, back-to-back meetings,
 * events that start before the window and end inside it — testable without a
 * network or an account.
 */

export interface Interval {
  start: Date;
  end: Date;
}

export interface FindFreeSlotsInput {
  /** The window to search inside; half-open, `[start, end)`. */
  window: Interval;
  /** Anything already taken. May overlap, nest, repeat or fall outside. */
  busy: Interval[];
  /** Shortest gap worth reporting. */
  minimumMinutes: number;
  /** Cap on how many gaps come back, soonest first. */
  limit: number;
}

/**
 * Merges overlapping and touching intervals into a minimal ordered set.
 *
 * Touching matters as much as overlapping: two meetings that end and start at
 * 15:00 leave no gap between them, and treating them as separate would report
 * a zero-length slot.
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => i.end.getTime() > i.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.start.getTime() <= last.end.getTime()) {
      if (current.end.getTime() > last.end.getTime()) last.end = current.end;
      continue;
    }
    merged.push({ start: current.start, end: current.end });
  }
  return merged;
}

/**
 * The gaps in `window` not covered by `busy`, each at least
 * `minimumMinutes` long, soonest first.
 */
export function findFreeSlots({
  window,
  busy,
  minimumMinutes,
  limit,
}: FindFreeSlotsInput): Interval[] {
  if (window.end.getTime() <= window.start.getTime()) {
    throw new InvalidInputError("The search window ends before it starts.");
  }
  if (!Number.isInteger(minimumMinutes) || minimumMinutes < 1) {
    throw new InvalidInputError("The minimum slot length must be a whole number of minutes.");
  }

  const minimumMs = minimumMinutes * 60_000;
  const slots: Interval[] = [];
  let cursor = window.start;

  for (const taken of mergeIntervals(busy)) {
    // Events reaching in from outside the window only move the cursor; they
    // never produce a slot of their own.
    if (taken.end.getTime() <= cursor.getTime()) continue;
    if (taken.start.getTime() >= window.end.getTime()) break;

    if (taken.start.getTime() - cursor.getTime() >= minimumMs) {
      slots.push({ start: cursor, end: taken.start });
      if (slots.length === limit) return slots;
    }
    if (taken.end.getTime() > cursor.getTime()) cursor = taken.end;
  }

  if (window.end.getTime() - cursor.getTime() >= minimumMs) {
    slots.push({ start: cursor, end: window.end });
  }
  return slots.slice(0, limit);
}
