/**
 * Reads .ics calendar files (with ical.js) and answers "what's on this day?".
 *
 * ical.js parses the file and generates the clock times a repeat rule
 * produces. Everything that depends on time zones is done here instead:
 * converting clock times to real instants, the UNTIL cut-off, EXDATE and
 * RECURRENCE-ID matching, RDATEs in their own zones, skipping clock times
 * that don't exist (the hour lost when clocks go forward), and day/week
 * DURATIONs that keep the clock time across daylight saving changes.
 *
 * Parsing happens once. Repeating events are expanded lazily, only around the
 * days someone actually views, and the occurrences found are kept so going
 * back and forth stays fast even for big calendars with years of events.
 */
import ICAL from "ical.js";
import {
  addDaysToWall,
  localWall,
  sameWall,
  utcWall,
  wallOfInstant,
  dayNumber,
  dayNumberToDate,
  dayRange,
  floatingToInstant,
  resolveZone,
  wallExists,
  wallToInstant,
  type Wall,
} from "./time";

type ICALTime = InstanceType<typeof ICAL.Time>;
type ICALComponent = InstanceType<typeof ICAL.Component>;
type ICALRecur = InstanceType<typeof ICAL.Recur>;
type ICALDuration = InstanceType<typeof ICAL.Duration>;
type RecurIterator = ReturnType<ICALRecur["iterator"]>;

export class CalendarError extends Error {}

export interface EventInfo {
  title: string;
  location: string;
}

/** A timed appointment on one day, as real instants (ms). */
export interface DayEvent extends EventInfo {
  id: string;
  start: number;
  end: number;
}

export interface AllDayItem extends EventInfo {
  id: string;
  /** For all-day events that run several days: their first and last day (day numbers). */
  firstDay: number;
  lastDay: number;
  /** A timed event that covers this whole day (say, a trip), with its real start and end. */
  timed?: { start: number; end: number };
}

export interface DayEvents {
  day: number;
  allDay: AllDayItem[];
  timed: DayEvent[];
  /** How many repeating events couldn't be worked out for this day (so aren't shown). */
  failedSeries: number;
}

export interface CalendarSummary {
  events: number;
  recurring: number;
  calendars: number;
  /** Events the app couldn't read at all (no usable start time, or a repeat rule it can't follow). */
  unreadable: number;
  /**
   * Repeating events changed "from here on" between all-day and timed. The
   * app keeps showing them the original way (with the new title), and says so.
   */
  kindChanges: number;
}

/** How long an event lasts: exact elapsed time, or calendar days/weeks plus a time (keeps the clock time across DST). */
type Length = { exact: number } | { days: number; ms: number };

/** Converts clock times in one zone to instants. */
interface Zoner {
  toInstant(w: Wall): number;
  /** The clock reading of an instant in this zone. */
  wallOf(ms: number): Wall;
  /** Whether this clock time happens at all (false in the hour skipped when clocks go forward). */
  exists(w: Wall): boolean;
}

interface Single extends EventInfo {
  id: string;
  allDay: boolean;
  /** Timed: instants. All-day: day numbers, end exclusive. */
  start: number;
  end: number;
}

interface Occurrence {
  key: number;
  end: number;
  /** An RDATE PERIOD: its own end wins over the series length for that start. */
  period?: boolean;
}

/** A RECURRENCE-ID;RANGE=THISANDFUTURE change: applies to every later occurrence. */
interface FutureChange extends EventInfo {
  fromKey: number;
  /** Rough shift as elapsed time (ms, or days for all-day series), for search bounds. */
  shift: number;
  /**
   * The shift as calendar days plus clock time in the series' zone, like
   * ical.js does it: moving Friday 09:00 to Monday 09:00 stays 09:00 on every
   * later Monday, even across a clock change.
   */
  civil: { days: number; ms: number };
  /** The changed length: Length for timed series (kept nominal for day/week DURATIONs), days for all-day ones. */
  length: Length | number;
  zoner: Zoner;
  cancelled: boolean;
}

interface RuleState {
  it: RecurIterator;
  count: number | null;
  n: number;
  untilKey: number | null;
  untilDay: number | null;
  /** The next value is the series start itself (always an occurrence, even in a skipped hour). */
  first: boolean;
  peek: (Occurrence & { day: number }) | null;
}

interface Series extends EventInfo {
  id: string;
  allDay: boolean;
  /** The start as a plain clock time (no zone), which repeat rules run on. */
  dtstart: ICALTime;
  zoner: Zoner;
  /** Timed: Length. All-day: days. */
  length: Length | number;
  /** Longest occurrence, in ms (timed) or days (all-day), for searching back from a day. */
  maxLength: number;
  rules: { recur: ICALRecur; count: number | null; untilKey: number | null; untilDay: number | null }[];
  /** The start itself and every RDATE, each in its own zone. */
  extra: Occurrence[];
  /** Occurrences replaced by an override or excluded (keys). */
  skip: Set<number>;
  /** EXDATEs given as plain dates for a timed series: every occurrence on that clock date. */
  skipDays: Set<number>;
  future: FutureChange[];
  shiftMin: number;
  shiftMax: number;
  /** How to jump ahead in the series without walking every earlier occurrence, if safe. */
  jump: { freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"; interval: number } | null;
  states: RuleState[];
  /** Occurrences from rules are known from here on (instant or day number). */
  windowStart: number;
  /** Rule occurrence starts found so far, ascending, with their ends. Includes skipped ones. */
  starts: number[];
  ends: number[];
  done: boolean;
  failed: boolean;
}

/** Re-anchoring is worth it when the viewed day is this far past what's been expanded. */
const FAR_DAYS = 400;
/** Recurring series stop expanding after this many occurrences. */
const MAX_OCCURRENCES = 200_000;
/** Single events longer than this are checked on every day rather than by index. */
const LONG_MS = 2 * 86400000;
const LONG_DAYS = 2;
const DAY_MS = 86400000;

function text(comp: ICALComponent, name: string): string {
  const v = comp.getFirstPropertyValue(name);
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function wall(t: ICALTime): Wall {
  return { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second };
}

function isTime(v: unknown): v is ICALTime {
  return !!v && typeof v === "object" && "year" in v && "isDate" in v;
}

function param(comp: ICALComponent, prop: string, name: string): string | null {
  const v = comp.getFirstProperty(prop)?.getParameter(name);
  return typeof v === "string" ? v : null;
}

const UTC: Zoner = {
  toInstant: (w) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second),
  wallOf: utcWall,
  exists: () => true,
};
const FLOATING: Zoner = { toInstant: floatingToInstant, wallOf: localWall, exists: (w) => wallExists(w, null) };
const ianaZoners = new Map<string, Zoner>();

/**
 * How to read a date-time: UTC ("Z") times are exact; times with a TZID use the
 * browser's own time zone data when it knows the zone, else the zone
 * definition inside the file; times with no zone are local clock time.
 */
function zonerFor(t: ICALTime, tzid: string | null): Zoner {
  const zoneId = t.zone?.tzid;
  if (zoneId === "UTC" || zoneId === "Z") return UTC;
  const name = tzid ?? (zoneId && zoneId !== "floating" ? zoneId : null);
  if (name) {
    const resolved = resolveZone(name);
    if (resolved) {
      let z = ianaZoners.get(resolved);
      if (!z) {
        z = { toInstant: (w) => wallToInstant(w, resolved), wallOf: (ms) => wallOfInstant(ms, resolved), exists: (w) => wallExists(w, resolved) };
        ianaZoners.set(resolved, z);
      }
      return z;
    }
    const zone = t.zone as (typeof t.zone & { component?: unknown }) | undefined;
    if (zone && zoneId && zoneId !== "floating" && zone.component) {
      // A zone only the file defines (Outlook writes names like "Eastern Standard
      // Time"). ical.js gives the offset in force at a clock time from that
      // definition; turning instants back into clock times is done here, as
      // ical.js gets that wrong around clock changes.
      const tz = zone as unknown as { utcOffset(t: ICALTime): number };
      const offsetAtWall = (w: Wall) => tz.utcOffset(ICAL.Time.fromData({ ...w, isDate: false }, zone)) * 1000;
      const wallOf = (ms: number) => {
        // Offsets in force within a day either side; keep those that read back consistently.
        const offsets = new Set<number>();
        for (const h of [-26, -13, 0, 13, 26]) offsets.add(offsetAtWall(utcWall(ms + h * 3600000)));
        const fits = [...offsets].filter((o) => offsetAtWall(utcWall(ms + o)) === o);
        // Two can fit only in the hour skipped when clocks go forward; the earlier (smaller) offset is the real one there.
        const o = fits.length ? Math.min(...fits) : [...offsets][0];
        return utcWall(ms + o);
      };
      // Clock time to instant, read the same way as for zones the browser knows:
      // a repeated time (clocks going back) is its first occurrence, and a
      // skipped one (clocks going forward) moves forward past the jump.
      const toInstant = (w: Wall) => {
        const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
        const before = offsetAtWall(addDaysToWall(w, -1));
        const after = offsetAtWall(addDaysToWall(w, 1));
        const fits = [before, after].map((o) => asUtc - o).filter((t) => sameWall(wallOf(t), w));
        return fits.length ? Math.min(...fits) : asUtc - before;
      };
      // A clock time exists if turning it into an instant and back gives it again.
      return { toInstant, wallOf, exists: (w) => sameWall(wallOf(toInstant(w)), w) };
    }
  }
  return FLOATING;
}

function dateDay(t: { year: number; month: number; day: number }): number {
  return dayNumber(t.year, t.month, t.day);
}

function dayNumberOfInstant(ms: number): number {
  const d = new Date(ms);
  return dayNumber(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function info(comp: ICALComponent): EventInfo {
  return { title: text(comp, "summary") || "Busy", location: text(comp, "location") };
}

function isCancelled(comp: ICALComponent): boolean {
  return text(comp, "status").toUpperCase() === "CANCELLED";
}

function durationOf(comp: ICALComponent): ICALDuration | null {
  const d = comp.getFirstPropertyValue("duration");
  return d && typeof d === "object" && "toSeconds" in d ? (d as ICALDuration) : null;
}

/** Days and weeks are calendar days (keep the clock time); hours, minutes and seconds are elapsed time. */
function lengthOf(d: ICALDuration): Length {
  const ms = (d.hours * 3600 + d.minutes * 60 + d.seconds) * 1000;
  const days = d.weeks * 7 + d.days;
  return days ? { days, ms } : { exact: ms };
}

/** Upper bound of a Length in ms (a calendar day can be 25 hours). */
function longest(length: Length): number {
  return "exact" in length ? length.exact : length.days * DAY_MS + length.ms + 3600000;
}

function endOf(w: Wall, key: number, zoner: Zoner, length: Length): number {
  if ("exact" in length) return key + length.exact;
  return zoner.toInstant(addDaysToWall(w, length.days)) + length.ms;
}

interface Timing {
  allDay: boolean;
  dtstart: ICALTime;
  zoner: Zoner;
  start: number;
  /** Timed: Length. All-day: days. */
  length: Length | number;
}

/** When an event starts and how long it lasts, or null if unreadable. */
function readTiming(comp: ICALComponent): Timing | null {
  const dtstart = comp.getFirstPropertyValue("dtstart");
  if (!isTime(dtstart)) return null;
  const dtend = comp.getFirstPropertyValue("dtend");
  const duration = durationOf(comp);
  if (dtstart.isDate) {
    const start = dateDay(dtstart);
    let days = 1;
    if (isTime(dtend)) days = dateDay(dtend) - start;
    else if (duration && !duration.isNegative) days = duration.weeks * 7 + duration.days + Math.floor((duration.hours * 3600 + duration.minutes * 60 + duration.seconds) / 86400);
    return { allDay: true, dtstart, zoner: FLOATING, start, length: Math.max(1, days) };
  }
  const zoner = zonerFor(dtstart, param(comp, "dtstart", "tzid"));
  const start = zoner.toInstant(wall(dtstart));
  if (!Number.isFinite(start)) return null;
  let length: Length = { exact: 0 };
  if (isTime(dtend)) {
    const end = dtend.isDate ? zoner.toInstant(wall(dtend)) : zonerFor(dtend, param(comp, "dtend", "tzid")).toInstant(wall(dtend));
    length = { exact: Math.max(0, end - start) };
  } else if (duration && !duration.isNegative) {
    // Days and weeks are calendar days: 1 day from noon ends at noon even across a clock change.
    length = lengthOf(duration);
  }
  return { allDay: false, dtstart, zoner, start, length };
}

function singleFrom(comp: ICALComponent, id: string): Single | null {
  const t = readTiming(comp);
  if (!t) return null;
  const end = t.allDay ? t.start + (t.length as number) : endOf(wall(t.dtstart), t.start, t.zoner, t.length as Length);
  return { id, ...info(comp), allDay: t.allDay, start: t.start, end };
}

/** The key of a RECURRENCE-ID / EXDATE / RDATE time, read like the series start. */
function keyOf(v: ICALTime, tzid: string | null, series: { allDay: boolean; tzid: string | null; dtstart: ICALTime; zoner: Zoner }): number {
  if (series.allDay) {
    if (v.isDate) return dateDay(v);
    return dayNumberOfInstant(zonerFor(v, tzid).toInstant(wall(v)));
  }
  if (v.isDate) {
    // A plain date for a timed series: that date at the series' clock time.
    return series.zoner.toInstant({ ...wall(series.dtstart), year: v.year, month: v.month, day: v.day });
  }
  return zonerFor(v, tzid ?? series.tzid).toInstant(wall(v));
}

/**
 * Reads a calendar whose full parse failed by parsing each event on its own
 * (with the file's time zone definitions), keeping the ones that parse.
 */
function parseLeniently(t: string): { parsed: unknown; dropped: number } | null {
  if (!/BEGIN:VCALENDAR/i.test(t)) return null;
  const zones = t.match(/^BEGIN:VTIMEZONE\r?\n[\s\S]*?^END:VTIMEZONE\r?$/gim) ?? [];
  const events = t.match(/^BEGIN:VEVENT\r?\n[\s\S]*?^END:VEVENT\r?$/gim) ?? [];
  const wrap = (parts: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...parts, "END:VCALENDAR"].join("\r\n");
  const goodZones = zones.filter((z) => {
    try {
      ICAL.parse(wrap([z]));
      return true;
    } catch {
      return false;
    }
  });
  const good: string[] = [];
  let dropped = 0;
  for (const e of events) {
    try {
      ICAL.parse(wrap([e]));
      good.push(e);
    } catch {
      dropped++;
    }
  }
  // Events cut off part-way (a truncated file) count as unreadable too.
  dropped += Math.max(0, (t.match(/^BEGIN:VEVENT\r?$/gim) ?? []).length - events.length);
  if (good.length === 0 && dropped > 0) return null;
  try {
    return { parsed: ICAL.parse(wrap([...goodZones, ...good])), dropped };
  } catch {
    return null;
  }
}

/** The calendar-day and clock-time difference between two instants, read in a zone. */
function civilShift(allDay: boolean, zoner: Zoner, from: number, to: number): { days: number; ms: number } {
  if (allDay) return { days: to - from, ms: 0 };
  const a = zoner.wallOf(from);
  const b = zoner.wallOf(to);
  const clock = (w: Wall) => ((w.hour * 60 + w.minute) * 60 + w.second) * 1000;
  return { days: dateDay(b) - dateDay(a), ms: clock(b) - clock(a) };
}

/** Moves an occurrence by calendar days and clock time in the series' zone, then reads it as an instant. */
function applyCivil(s: { allDay: boolean; zoner: Zoner }, key: number, shift: { days: number; ms: number }): number {
  if (s.allDay) return key + shift.days;
  const w = s.zoner.wallOf(key);
  const moved = utcWall(Date.UTC(w.year, w.month - 1, w.day + shift.days, w.hour, w.minute, w.second) + shift.ms);
  return s.zoner.toInstant(moved);
}

function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Calendar {
  private timedSingles: Single[] = [];
  private timedStarts: number[] = [];
  private maxTimedLength = 0;
  private longTimed: Single[] = [];
  private allDaySingles: Single[] = [];
  private allDayStarts: number[] = [];
  private maxAllDayLength = 0;
  private longAllDay: Single[] = [];
  private series: Series[] = [];
  readonly summary: CalendarSummary;

  private readonly jumpAhead: boolean;
  private kindChanges = 0;

  /** `jumpAhead: false` walks every series from its start (used by tests to check jumping). */
  constructor(texts: string[], options: { jumpAhead?: boolean } = {}) {
    this.jumpAhead = options.jumpAhead ?? true;
    const singles: Single[] = [];
    let calendars = 0;
    let unreadable = 0;
    let n = 0;
    for (const t of texts) {
      let parsed: unknown;
      try {
        parsed = ICAL.parse(t);
      } catch {
        // One bad line shouldn't lose the whole calendar: read event by event.
        const lenient = parseLeniently(t);
        if (!lenient) throw new CalendarError("This file couldn't be read as a calendar. Check it's an .ics file exported from your calendar.");
        parsed = lenient.parsed;
        unreadable += lenient.dropped;
      }
      const roots = (Array.isArray(parsed) && typeof parsed[0] === "string" ? [parsed] : (parsed as unknown[])) as unknown[];
      for (const root of roots) {
        let vcal: ICALComponent;
        try {
          vcal = new ICAL.Component(root as never);
        } catch {
          continue;
        }
        if (vcal.name !== "vcalendar") continue;
        calendars++;
        // Overrides of occurrences of a series, grouped by series UID.
        const overrides = new Map<string, ICALComponent[]>();
        const masters: ICALComponent[] = [];
        for (const ev of vcal.getAllSubcomponents("vevent")) {
          try {
            if (ev.hasProperty("recurrence-id")) {
              const uid = text(ev, "uid");
              const list = overrides.get(uid) ?? [];
              list.push(ev);
              overrides.set(uid, list);
            } else if (ev.hasProperty("rrule") || ev.hasProperty("rdate")) {
              masters.push(ev);
            } else if (!isCancelled(ev)) {
              const s = singleFrom(ev, `e${n++}`);
              if (s) singles.push(s);
              else unreadable++;
            }
          } catch {
            unreadable++;
          }
        }
        for (const m of masters) {
          if (isCancelled(m)) continue;
          try {
            const s = this.readSeries(m, `s${n++}`, overrides.get(text(m, "uid")) ?? []);
            if (s && !s.failed) this.series.push(s);
            else unreadable++;
          } catch {
            unreadable++;
          }
        }
        // Overrides become ordinary events at their own (possibly moved) time.
        // Orphan overrides (no series in the file) are kept too.
        for (const [, list] of overrides) {
          for (const ov of list) {
            if (isCancelled(ov)) continue;
            try {
              const s = singleFrom(ov, `e${n++}`);
              if (s) singles.push(s);
              else unreadable++;
            } catch {
              unreadable++;
            }
          }
        }
      }
    }
    if (calendars === 0) {
      throw new CalendarError("This file doesn't contain a calendar. Check it's an .ics file exported from your calendar.");
    }

    for (const s of singles) {
      if (s.allDay) {
        if (s.end - s.start > LONG_DAYS) this.longAllDay.push(s);
        else this.allDaySingles.push(s);
      } else if (s.end - s.start > LONG_MS) this.longTimed.push(s);
      else this.timedSingles.push(s);
    }
    this.timedSingles.sort((a, b) => a.start - b.start);
    this.timedStarts = this.timedSingles.map((s) => s.start);
    this.maxTimedLength = this.timedSingles.reduce((m, s) => Math.max(m, s.end - s.start), 0);
    this.allDaySingles.sort((a, b) => a.start - b.start);
    this.allDayStarts = this.allDaySingles.map((s) => s.start);
    this.maxAllDayLength = this.allDaySingles.reduce((m, s) => Math.max(m, s.end - s.start), 0);

    // A file whose events all failed isn't an (empty) calendar: don't let it replace a working one.
    if (singles.length + this.series.length === 0 && unreadable > 0) {
      throw new CalendarError(
        `None of the events in this file could be read (${unreadable === 1 ? "1 event" : `${unreadable} events`}), so it wasn't opened. Try exporting your calendar again.`,
      );
    }
    this.summary = { events: singles.length + this.series.length, recurring: this.series.length, calendars, unreadable, kindChanges: this.kindChanges };
  }

  private readSeries(comp: ICALComponent, id: string, overrides: ICALComponent[]): Series | null {
    const timing = readTiming(comp);
    if (!timing) return null;
    const { allDay, zoner, length } = timing;
    const tzid = param(comp, "dtstart", "tzid");
    const d0 = timing.dtstart;
    // Repeat rules run on plain clock times; this layer applies the zone.
    const dtstart = ICAL.Time.fromData({ year: d0.year, month: d0.month, day: d0.day, hour: d0.hour, minute: d0.minute, second: d0.second, isDate: d0.isDate });
    const ctx = { allDay, tzid, dtstart, zoner };

    const skip = new Set<number>();
    const skipDays = new Set<number>();
    const future: FutureChange[] = [];
    for (const ov of overrides) {
      const rid = ov.getFirstPropertyValue("recurrence-id");
      if (!isTime(rid)) continue;
      const ridKey = keyOf(rid, param(ov, "recurrence-id", "tzid"), ctx);
      skip.add(ridKey);
      if ((param(ov, "recurrence-id", "range") ?? "").toUpperCase() === "THISANDFUTURE") {
        const ot = readTiming(ov);
        if (!ot && !isCancelled(ov)) continue;
        const sameKind = !!ot && ot.allDay === allDay;
        if (ot && !sameKind) this.kindChanges++;
        future.push({
          fromKey: ridKey,
          shift: ot && sameKind ? ot.start - ridKey : 0,
          civil: ot && sameKind ? civilShift(allDay, zoner, ridKey, ot.start) : { days: 0, ms: 0 },
          // Keep the change's own length, nominal or exact, so each later occurrence works it out from its own date.
          length: ot && sameKind ? ot.length : length,
          zoner: ot && sameKind ? ot.zoner : zoner,
          cancelled: isCancelled(ov),
          ...info(ov),
        });
      }
    }
    future.sort((a, b) => a.fromKey - b.fromKey);

    for (const p of comp.getAllProperties("exdate")) {
      const pz = p.getParameter("tzid");
      for (const v of p.getValues()) {
        if (!isTime(v)) continue;
        if (v.isDate && !allDay) skipDays.add(dateDay(v));
        else skip.add(keyOf(v, typeof pz === "string" ? pz : null, ctx));
      }
    }

    const occurrenceOf = (w: Wall, key: number): Occurrence => ({
      key,
      end: allDay ? key + (length as number) : endOf(w, key, zoner, length as Length),
    });

    // The start itself and every RDATE (each in its own zone; PERIODs carry their own end).
    const extra: Occurrence[] = [occurrenceOf(wall(dtstart), timing.start)];
    for (const p of comp.getAllProperties("rdate")) {
      const pz = p.getParameter("tzid");
      const pzone = typeof pz === "string" ? pz : null;
      for (const v of p.getValues()) {
        if (isTime(v)) {
          const key = keyOf(v, pzone, ctx);
          const w = v.isDate && !allDay ? { ...wall(dtstart), year: v.year, month: v.month, day: v.day } : wall(v);
          extra.push(allDay ? { key, end: key + (length as number) } : { key, end: v.isDate ? endOf(w, key, zoner, length as Length) : endOf(w, key, zonerFor(v, pzone ?? tzid), length as Length) });
          if (!allDay && v.isDate && skipDays.has(dateDay(v))) skip.add(key);
        } else if (v && typeof v === "object" && "start" in v) {
          const period = v as InstanceType<typeof ICAL.Period>;
          const startT = period.start;
          if (!isTime(startT)) continue;
          const key = keyOf(startT, pzone, ctx);
          let end: number;
          if (period.duration) {
            // Start + duration: hours are elapsed time, days keep the clock time.
            const pzoner = zonerFor(startT, pzone ?? tzid);
            end = allDay ? key + Math.max(1, period.duration.weeks * 7 + period.duration.days) : endOf(wall(startT), key, pzoner, lengthOf(period.duration));
          } else {
            const endT = period.getEnd();
            end = allDay ? Math.max(key + 1, dateDay(endT)) : Math.max(key, zonerFor(endT, pzone ?? tzid).toInstant(wall(endT)));
          }
          extra.push({ key, end, period: true });
        }
      }
    }
    if (!allDay) for (const o of extra) if (skipDays.has(dayNumberOfInstant(o.key))) skip.add(o.key);
    extra.sort((a, b) => a.key - b.key);

    const rules: Series["rules"] = [];
    for (const p of comp.getAllProperties("rrule")) {
      const recur = p.getFirstValue() as ICALRecur;
      if (!recur || typeof recur !== "object" || !("freq" in recur)) return null;
      let untilKey: number | null = null;
      let untilDay: number | null = null;
      const until = recur.until as ICALTime | null | undefined;
      if (isTime(until)) {
        if (until.isDate) untilDay = dateDay(until);
        else if (allDay) untilDay = dayNumberOfInstant(zonerFor(until, null).toInstant(wall(until)));
        // UNTIL in UTC is exact; a UNTIL without "Z" is read in the series' zone.
        else untilKey = zonerFor(until, tzid).toInstant(wall(until));
      }
      const stripped = recur.clone();
      stripped.count = null as unknown as number;
      stripped.until = null as unknown as ICALTime;
      // A plain yearly rule starting on 29 February means "every 29 February"
      // (ical.js would roll it to 1 March in other years and use up COUNT).
      const parts = (stripped as unknown as { parts: Record<string, unknown[]> }).parts;
      if (stripped.freq === "YEARLY" && d0.month === 2 && d0.day === 29 && Object.keys(parts).length === 0) {
        parts.BYMONTH = [2];
        parts.BYMONTHDAY = [29];
      }
      rules.push({ recur: stripped, count: recur.count ? Number(recur.count) : null, untilKey, untilDay });
    }

    // A series can jump ahead (start from a later occurrence) when it has one
    // plain repeating rule: no COUNT (which needs every earlier occurrence) and
    // a start day that exists in every month.
    let jump: Series["jump"] = null;
    if (this.jumpAhead && rules.length === 1 && rules[0].count === null) {
      const freq = rules[0].recur.freq;
      const interval = Math.max(1, Number(rules[0].recur.interval) || 1);
      if (freq === "DAILY" || freq === "WEEKLY" || ((freq === "MONTHLY" || freq === "YEARLY") && dtstart.day <= 28)) {
        jump = { freq, interval };
      }
    }

    // The longest any occurrence can be, so a day looks back far enough for ones still running.
    const lengthBound = (l: Length | number) => (allDay ? (l as number) : longest(l as Length));
    let maxLength = lengthBound(length);
    for (const o of extra) maxLength = Math.max(maxLength, o.end - o.key);
    for (const f of future) maxLength = Math.max(maxLength, lengthBound(f.length));

    const series: Series = {
      id,
      ...info(comp),
      allDay,
      dtstart,
      zoner,
      length,
      maxLength,
      rules,
      extra,
      skip,
      skipDays,
      future,
      // A clock-time shift is a different elapsed time at every clock change
      // (and differs again between the series' zone and the device's), so the
      // search is padded by a whole day each way; each moved occurrence is then
      // checked exactly against the day being viewed.
      shiftMin: Math.min(0, ...future.map((f) => f.shift - (allDay ? 1 : DAY_MS))),
      shiftMax: Math.max(0, ...future.map((f) => f.shift + (allDay ? 1 : DAY_MS))),
      jump,
      states: [],
      windowStart: -Infinity,
      starts: [],
      ends: [],
      done: rules.length === 0,
      failed: false,
    };
    // Starting the rules also checks they can be followed at all, so a rule
    // the app can't handle is reported on import rather than silently empty.
    if (rules.length) this.restart(series, -Infinity);
    return series;
  }

  /**
   * (Re)starts expanding a series' rules so that every occurrence from `from`
   * on will be found: from the series' own start, or, when the rule allows,
   * from a whole number of repeats later (so the pattern lines up exactly).
   */
  private restart(s: Series, from: number): void {
    let anchor = s.dtstart;
    let windowStart = -Infinity;
    let moved = false;
    if (s.jump && Number.isFinite(from)) {
      // A couple of days' margin covers the gap between the series' time zone and ours.
      const fromDay = (s.allDay ? from : dayNumberOfInstant(from)) - 2;
      const startDay = dateDay(s.dtstart);
      const { freq, interval } = s.jump;
      const t = s.dtstart.clone();
      if (freq === "DAILY" || freq === "WEEKLY") {
        const period = freq === "DAILY" ? interval : interval * 7;
        const k = Math.floor((fromDay - startDay) / period);
        if (k > 0) {
          t.adjust(k * period, 0, 0, 0);
          moved = true;
        }
      } else {
        const f = dayNumberToDate(fromDay);
        if (freq === "MONTHLY") {
          const months = f.year * 12 + (f.month - 1) - (s.dtstart.year * 12 + (s.dtstart.month - 1)) - 1;
          const k = Math.floor(months / interval);
          if (k > 0) {
            const total = s.dtstart.year * 12 + (s.dtstart.month - 1) + k * interval;
            t.year = Math.floor(total / 12);
            t.month = (total % 12) + 1;
            moved = true;
          }
        } else {
          const k = Math.floor((f.year - s.dtstart.year - 1) / interval);
          if (k > 0) {
            t.year = s.dtstart.year + k * interval;
            moved = true;
          }
        }
      }
      if (moved) {
        anchor = t;
        // The new anchor itself might not match the rule (an iterator always
        // returns its start), so only trust what comes after it.
        windowStart = (s.allDay ? dateDay(anchor) : s.zoner.toInstant(wall(anchor))) + 1;
      }
    }
    s.states = [];
    s.done = false;
    try {
      for (const r of s.rules) {
        const st: RuleState = { it: r.recur.iterator(anchor.clone()), count: r.count, n: 0, untilKey: r.untilKey, untilDay: r.untilDay, first: !moved, peek: null };
        this.advance(s, st);
        s.states.push(st);
      }
    } catch {
      s.failed = true;
      s.done = true;
    }
    s.windowStart = windowStart;
    s.starts = [];
    s.ends = [];
  }

  /** Moves a rule to its next real occurrence (skipping clock times that don't exist, which don't count). */
  private advance(s: Series, st: RuleState): void {
    st.peek = null;
    for (let guard = 0; guard < 10_000; guard++) {
      const t = st.it.next();
      if (!t) return;
      const w = wall(t);
      const explicit = st.first;
      st.first = false;
      if (!s.allDay && !explicit && !s.zoner.exists(w)) continue;
      const day = dateDay(t);
      const key = s.allDay ? day : s.zoner.toInstant(w);
      if (st.untilKey !== null && key > st.untilKey) return;
      if (st.untilDay !== null && day > st.untilDay) return;
      st.n++;
      if (st.count !== null && st.n > st.count) return;
      st.peek = { key, day, end: s.allDay ? key + (s.length as number) : endOf(w, key, s.zoner, s.length as Length) };
      return;
    }
  }

  /** Makes sure every rule occurrence starting in [from, to) is known. */
  private ensure(s: Series, from: number, to: number): void {
    if (s.failed) return;
    const far = s.allDay ? FAR_DAYS : FAR_DAYS * DAY_MS;
    const known = s.starts.length ? s.starts[s.starts.length - 1] : s.windowStart;
    if (from < s.windowStart || (s.jump && !s.done && known < from - far)) this.restart(s, from);
    try {
      while (!s.done) {
        const last = s.starts.length ? s.starts[s.starts.length - 1] : -Infinity;
        if (last >= to) return;
        let best: RuleState | null = null;
        for (const st of s.states) if (st.peek && (!best || st.peek.key < best.peek!.key)) best = st;
        if (!best || s.starts.length >= MAX_OCCURRENCES) {
          s.done = true;
          return;
        }
        const occ = best.peek!;
        this.advance(s, best);
        if (occ.key < s.windowStart || occ.key <= last) continue;
        // Skipped occurrences are recorded too (and filtered when read), so the
        // expansion always knows how far it has got.
        if (!s.allDay && s.skipDays.has(occ.day)) s.skip.add(occ.key);
        s.starts.push(occ.key);
        s.ends.push(occ.end);
      }
    } catch {
      s.failed = true;
      s.done = true;
    }
  }

  /** Occurrences of a series starting in [from, to), after exclusions and "this and future" changes. */
  private occurrences(s: Series, from: number, to: number): (Occurrence & EventInfo)[] {
    const lo = from - s.shiftMax;
    const hi = to - s.shiftMin;
    const found = new Map<number, number>();
    if (s.rules.length) {
      this.ensure(s, lo, hi);
      for (let i = lowerBound(s.starts, lo); i < s.starts.length && s.starts[i] < hi; i++) found.set(s.starts[i], s.ends[i]);
    }
    // Extra dates join the set; a PERIOD's own end wins over the series length at the same start.
    for (const o of s.extra) if (o.key >= lo && o.key < hi && (o.period || !found.has(o.key))) found.set(o.key, o.end);
    const out: (Occurrence & EventInfo)[] = [];
    for (const [key, end] of found) {
      if (s.skip.has(key)) continue;
      let change: FutureChange | null = null;
      for (const f of s.future) if (f.fromKey < key) change = f;
      if (change?.cancelled) continue;
      const start = change ? applyCivil(s, key, change.civil) : key;
      let e = end;
      if (change) {
        e = s.allDay ? start + (change.length as number) : endOf(change.zoner.wallOf(start), start, change.zoner, change.length as Length);
      }
      if (start < from || start >= to) continue;
      out.push({ key: start, end: e, title: change?.title ?? s.title, location: change?.location ?? s.location });
    }
    return out;
  }

  /** Everything on one local day (a day number), in the device's time zone. */
  day(dayNum: number): DayEvents {
    const { start: dayStart, end: dayEnd } = dayRange(dayNum);
    const allDay: AllDayItem[] = [];
    const timed: DayEvent[] = [];
    let failedSeries = 0;

    const addTimed = (id: string, ev: EventInfo, start: number, end: number) => {
      const overlaps = start < dayEnd && (end > dayStart || (end === start && start >= dayStart));
      if (!overlaps) return;
      if (start <= dayStart && end >= dayEnd) {
        allDay.push({ id, title: ev.title, location: ev.location, firstDay: dayNum, lastDay: dayNum, timed: { start, end } });
      } else {
        timed.push({ id, title: ev.title, location: ev.location, start, end });
      }
    };
    const addAllDay = (id: string, ev: EventInfo, start: number, end: number) => {
      if (start <= dayNum && end > dayNum) allDay.push({ id, title: ev.title, location: ev.location, firstDay: start, lastDay: end - 1 });
    };

    // Single timed events: starts in [dayStart - longest, dayEnd).
    for (let i = lowerBound(this.timedStarts, dayStart - this.maxTimedLength); i < this.timedSingles.length; i++) {
      const s = this.timedSingles[i];
      if (s.start >= dayEnd) break;
      addTimed(s.id, s, s.start, s.end);
    }
    for (const s of this.longTimed) addTimed(s.id, s, s.start, s.end);
    for (let i = lowerBound(this.allDayStarts, dayNum - this.maxAllDayLength); i < this.allDaySingles.length; i++) {
      const s = this.allDaySingles[i];
      if (s.start > dayNum) break;
      addAllDay(s.id, s, s.start, s.end);
    }
    for (const s of this.longAllDay) addAllDay(s.id, s, s.start, s.end);

    for (const s of this.series) {
      const occ = s.allDay ? this.occurrences(s, dayNum - s.maxLength + 1, dayNum + 1) : this.occurrences(s, dayStart - s.maxLength, dayEnd);
      if (s.failed) failedSeries++;
      for (const o of occ) {
        if (s.allDay) addAllDay(`${s.id}-${o.key}`, o, o.key, Math.max(o.key + 1, o.end));
        else addTimed(`${s.id}-${o.key}`, o, o.key, o.end);
      }
    }

    timed.sort((a, b) => a.start - b.start || b.end - a.end || a.title.localeCompare(b.title));
    allDay.sort((a, b) => a.firstDay - b.firstDay || a.title.localeCompare(b.title));
    return { day: dayNum, allDay, timed, failedSeries };
  }
}
