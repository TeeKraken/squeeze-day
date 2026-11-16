/**
 * Turning calendar wall-clock times into real instants, and local days into
 * ranges. Everything is shown in the device's own time zone.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (formatterCache.has(zone)) return formatterCache.get(zone)!;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    f = null;
  }
  formatterCache.set(zone, f);
  return f;
}

/** A few Windows time zone names that some calendar programs write without a definition. */
const WINDOWS_ZONES: Record<string, string> = {
  "Pacific Standard Time": "America/Los_Angeles",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Central Standard Time": "America/Chicago",
  "Eastern Standard Time": "America/New_York",
  "Atlantic Standard Time": "America/Halifax",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
  UTC: "UTC",
};

/**
 * Finds a time zone name the browser understands for a calendar TZID, or null.
 * Handles plain IANA names ("Europe/Berlin"), prefixed ones some programs write
 * ("/mozilla.org/20050126_1/Europe/Berlin") and common Windows names.
 */
export function resolveZone(tzid: string): string | null {
  const raw = tzid.trim().replace(/^"|"$/g, "");
  if (!raw) return null;
  const candidates = [raw, WINDOWS_ZONES[raw]];
  const m = raw.match(/([A-Za-z_]+\/[A-Za-z_+\-0-9]+(?:\/[A-Za-z_+\-0-9]+)?)$/);
  if (m) candidates.push(m[1]);
  for (const c of candidates) {
    if (c && formatterFor(c)) return c;
  }
  return null;
}

const offsetCache = new Map<string, Map<number, number>>();
/** Clock changes happen on a quarter hour, so offsets are cached per 15 minutes. */
const BUCKET = 15 * 60000;

/** The zone's offset from UTC (ms) at an instant. */
function offsetAt(zone: string, utcMs: number): number {
  let cache = offsetCache.get(zone);
  if (!cache) {
    cache = new Map();
    offsetCache.set(zone, cache);
  }
  const bucket = Math.floor(utcMs / BUCKET);
  let off = cache.get(bucket);
  if (off === undefined) {
    off = computeOffset(zone, bucket * BUCKET);
    if (cache.size > 500_000) cache.clear();
    cache.set(bucket, off);
  }
  return off;
}

function computeOffset(zone: string, utcMs: number): number {
  const f = formatterFor(zone)!;
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export interface Wall {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The instant (ms) when a zone's clocks show this wall time. Times skipped by DST move forward. */
export function wallToInstant(w: Wall, zone: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Try both offsets in force around this time; keep one that reads back right.
  const offA = offsetAt(zone, guess - 86400000);
  const offB = offsetAt(zone, guess + 86400000);
  const tA = guess - offA;
  const tB = guess - offB;
  const okA = offsetAt(zone, tA) === offA;
  const okB = offsetAt(zone, tB) === offB;
  if (okA && okB) return Math.min(tA, tB); // repeated hour: the first one
  if (okA) return tA;
  if (okB) return tB;
  // Skipped hour (clocks jumped forward): use the offset from before the jump.
  return guess - offA;
}

/** Floating times (no zone) mean "this clock time wherever you are". */
export function floatingToInstant(w: Wall): number {
  return new Date(w.year, w.month - 1, w.day, w.hour, w.minute, w.second).getTime();
}

/** A civil date as a day number (days since 1970-01-01), independent of time zone. */
export function dayNumber(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month - 1, day) / 86400000);
}

export function dayNumberToDate(n: number): { year: number; month: number; day: number } {
  const d = new Date(n * 86400000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Local day number of a Date in the device's zone. */
export function localDayNumber(d: Date): number {
  return dayNumber(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Start and end (exclusive) instants of a local day; DST days are 23 or 25 hours. */
export function dayRange(dayNum: number): { start: number; end: number } {
  const a = dayNumberToDate(dayNum);
  const b = dayNumberToDate(dayNum + 1);
  return {
    start: new Date(a.year, a.month - 1, a.day).getTime(),
    end: new Date(b.year, b.month - 1, b.day).getTime(),
  };
}

/** The wall clock reading of an instant in a zone. */
export function wallOfInstant(ms: number, zone: string): Wall {
  const f = formatterFor(zone)!;
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

const sameWall = (a: Wall, b: Wall) =>
  a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;

/**
 * Whether a clock time really happens in a zone (null = the device's own zone).
 * Times in the hour skipped when clocks go forward don't.
 */
export function wallExists(w: Wall, zone: string | null): boolean {
  if (zone === null) {
    const d = new Date(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    return sameWall(w, { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() });
  }
  const t = wallToInstant(w, zone);
  const d = new Date(t + offsetAt(zone, t));
  return sameWall(w, { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() });
}

/** The same clock time a number of calendar days later. */
export function addDaysToWall(w: Wall, days: number): Wall {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return { ...w, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
