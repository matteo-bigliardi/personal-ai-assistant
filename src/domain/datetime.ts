import { InvalidInputError } from "./errors.js";

/**
 * Deterministic date/time handling.
 *
 * The model never does calendar arithmetic. Every turn it receives a context
 * block computed here from the real clock — the current instant plus the next
 * seven calendar days with their weekday names — and it may only echo absolute
 * ISO-8601 instants back into tool arguments. Those are re-validated here
 * before anything is persisted, so a hallucinated date fails loudly instead of
 * silently landing in the database.
 *
 * Instants are stored in UTC; user-facing text is rendered in the configured
 * timezone.
 */

const DAY_MS = 86_400_000;
const DAYS_AHEAD = 7;

/** Guard rails against hallucinated years such as 0202 or 20265. */
const MIN_INSTANT_MS = Date.UTC(2000, 0, 1);
const MAX_YEARS_AHEAD = 10;

/**
 * Absolute ISO-8601 with a mandatory UTC offset. A bare local time
 * ("2026-08-29T15:00") is rejected on purpose: without an offset its meaning
 * depends on who reads it.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export const INSTANT_FORMAT_HINT =
  'an absolute ISO-8601 instant including the UTC offset, e.g. "2026-08-29T15:00:00+02:00"';

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parses an absolute instant, rejecting anything ambiguous, impossible or
 * absurd. Throws `InvalidInputError`, whose message is safe to show the model.
 */
export function parseInstant(value: unknown, now: Date = new Date()): Date {
  if (typeof value !== "string") {
    throw new InvalidInputError(`Expected ${INSTANT_FORMAT_HINT}, got ${typeof value}.`);
  }
  const match = ISO_INSTANT.exec(value);
  if (!match) {
    throw new InvalidInputError(`"${value}" is not ${INSTANT_FORMAT_HINT}.`);
  }

  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);

  // The regex accepts 2026-02-30; the Date constructor would silently roll it
  // over to March 2. Reject impossible calendar dates instead.
  if (month < 1 || month > 12) throw new InvalidInputError(`"${value}" has an invalid month.`);
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new InvalidInputError(`"${value}" is not a real calendar date.`);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new InvalidInputError(`"${value}" has an invalid time of day.`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidInputError(`"${value}" is not a valid instant.`);
  }

  const maxMs = now.getTime() + MAX_YEARS_AHEAD * 365 * DAY_MS;
  if (parsed.getTime() < MIN_INSTANT_MS || parsed.getTime() > maxMs) {
    throw new InvalidInputError(
      `"${value}" is outside the supported range (year 2000 to ${MAX_YEARS_AHEAD} years from now).`,
    );
  }
  return parsed;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  weekdayLong: string;
  offset: string;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    timeZoneName: "longOffset",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  // `longOffset` yields "GMT+02:00", or a bare "GMT" for UTC.
  const raw = get("timeZoneName");
  const offsetMatch = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(raw);
  const offset = offsetMatch
    ? `${offsetMatch[1]}${(offsetMatch[2] ?? "0").padStart(2, "0")}:${offsetMatch[3] ?? "00"}`
    : "+00:00";

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    weekdayLong: get("weekday"),
    offset,
  };
}

/** `2026-08-29T15:00:00+02:00` — the same instant, rendered in `timeZone`. */
export function formatInstant(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.offset}`;
}

/** `Saturday 2026-08-29 15:00` — for text meant to be read by a human. */
export function formatHuman(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.weekdayLong} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * The calendar date `offsetDays` days after `date`, as seen in `timeZone`.
 * Civil-date arithmetic is done in UTC, where days are always 24h long, so a
 * daylight-saving transition cannot skip or repeat a date.
 */
function civilDate(date: Date, timeZone: string, offsetDays: number): Date {
  const p = zonedParts(date, timeZone);
  return new Date(
    Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) + offsetDays * DAY_MS,
  );
}

/**
 * The per-turn context block. It is prepended to the user's message rather
 * than added to the system prompt: the system prompt and the tool definitions
 * are a stable, cacheable prefix, and a value that changes every second would
 * invalidate that cache on every single request.
 */
export function formatNowBlock(now: Date, timeZone: string): string {
  const p = zonedParts(now, timeZone);
  const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });

  const calendar: string[] = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = civilDate(now, timeZone, i);
    const label = `${weekdayFmt.format(d)} ${d.toISOString().slice(0, 10)}`;
    calendar.push(i === 0 ? `today ${label}` : label);
  }

  return [
    `[context] Current time: ${formatInstant(now, timeZone)} (${p.weekdayLong}), timezone ${timeZone}.`,
    `[context] Calendar: ${calendar.join(" | ")}.`,
    `[context] Resolve relative dates against the calendar above, never by guessing.`,
  ].join("\n");
}
