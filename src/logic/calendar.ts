/**
 * Reads .ics calendar files (with ical.js) and answers "what's on this day?".
 *
 * Parsing happens once. Recurring events are expanded lazily, only as far as
 * the days someone actually views, and the occurrences found are kept so
 * going back and forth stays fast even for big calendars with years of events.
 */
import ICAL from "ical.js";
import { dayNumber, dayNumberToDate, dayRange, floatingToInstant, resolveZone, wallToInstant, type Wall } from "./time";

type ICALTime = InstanceType<typeof ICAL.Time>;
type ICALComponent = InstanceType<typeof ICAL.Component>;

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
}

export interface CalendarSummary {
  events: number;
  recurring: number;
  calendars: number;
  /** Day numbers of the earliest and latest event start found (recurring series count by their first). */
  firstDay: number | null;
  lastDay: number | null;
}

interface Single extends EventInfo {
  id: string;
  allDay: boolean;
  /** Timed: instants. All-day: day numbers, end exclusive. */
  start: number;
  end: number;
}

interface Series extends EventInfo {
  id: string;
  allDay: boolean;
  component: ICALComponent;
  dtstart: ICALTime;
  zone: string | null;
  /** Timed: length in ms. All-day: length in days. */
  length: number;
  /** Original-occurrence keys that are replaced by an override or excluded. */
  skip: Set<number>;
  /** How to jump ahead in the series without walking every earlier occurrence, if safe. */
  jump: { freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"; interval: number } | null;
  expansion: InstanceType<typeof ICAL.RecurExpansion> | null;
  /** Occurrences are known from here on (instant or day number). */
  windowStart: number;
  /** Occurrence starts found so far (instants or day numbers), ascending; includes skipped ones. */
  starts: number[];
  done: boolean;
}

/** Re-anchoring is worth it when the viewed day is this far past what's been expanded. */
const FAR_DAYS = 400;

/** Recurring series stop expanding after this many occurrences. */
const MAX_OCCURRENCES = 200_000;
/** Single events longer than this are checked on every day rather than by index. */
const LONG_MS = 2 * 86400000;
const LONG_DAYS = 2;

function text(comp: ICALComponent, name: string): string {
  const v = comp.getFirstPropertyValue(name);
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function wall(t: ICALTime): Wall {
  return { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second };
}

function tzidOf(comp: ICALComponent, prop: string): string | null {
  const p = comp.getFirstProperty(prop);
  const v = p?.getParameter("tzid");
  return typeof v === "string" ? v : null;
}

/**
 * The instant of a date-time. UTC ("Z") times are exact; times with a TZID use
 * the browser's own time zone data when it knows the zone, else the zone
 * definition inside the file; times with no zone are read as local time.
 */
function instant(t: ICALTime, tzid: string | null): number {
  const zoneId = t.zone?.tzid;
  if (zoneId === "UTC" || zoneId === "Z") return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  const name = tzid ?? (zoneId && zoneId !== "floating" ? zoneId : null);
  if (name) {
    const resolved = resolveZone(name);
    if (resolved) return wallToInstant(wall(t), resolved);
    // Not a zone the browser knows (e.g. a custom name): use the file's definition.
    if (t.zone && zoneId && zoneId !== "floating" && (t.zone as { component?: unknown }).component) {
      return t.toUnixTime() * 1000;
    }
  }
  return floatingToInstant(wall(t));
}

function dateDay(t: ICALTime): number {
  return dayNumber(t.year, t.month, t.day);
}

/** A key for "which occurrence is this", comparable across the forms a file may write it in. */
function occurrenceKey(t: ICALTime, tzid: string | null, allDay: boolean): number {
  return allDay || t.isDate ? dateDay(t) : instant(t, tzid);
}

function info(comp: ICALComponent): EventInfo {
  return { title: text(comp, "summary") || "Busy", location: text(comp, "location") };
}

function isCancelled(comp: ICALComponent): boolean {
  return text(comp, "status").toUpperCase() === "CANCELLED";
}

/** Start/end of a non-recurring event (or one override), or null if unreadable. */
function readSingle(comp: ICALComponent, id: string): Single | null {
  const dtstart = comp.getFirstPropertyValue("dtstart") as ICALTime | null;
  if (!dtstart || typeof dtstart !== "object" || !("year" in dtstart)) return null;
  const startZone = tzidOf(comp, "dtstart");
  const dtend = comp.getFirstPropertyValue("dtend") as ICALTime | null;
  const durationValue = comp.getFirstPropertyValue("duration") as InstanceType<typeof ICAL.Duration> | null;
  if (dtstart.isDate) {
    const start = dateDay(dtstart);
    let end = start + 1;
    if (dtend && typeof dtend === "object" && "year" in dtend) end = dateDay(dtend);
    else if (durationValue && typeof durationValue === "object" && "toSeconds" in durationValue) {
      end = start + Math.max(1, Math.round(durationValue.toSeconds() / 86400));
    }
    if (end <= start) end = start + 1;
    return { id, ...info(comp), allDay: true, start, end };
  }
  const start = instant(dtstart, startZone);
  let end = start;
  if (dtend && typeof dtend === "object" && "year" in dtend) {
    end = dtend.isDate ? instant(dtend, startZone) : instant(dtend, tzidOf(comp, "dtend"));
  } else if (durationValue && typeof durationValue === "object" && "toSeconds" in durationValue) {
    end = start + durationValue.toSeconds() * 1000;
  }
  if (!(end >= start)) end = start;
  if (!Number.isFinite(start)) return null;
  return { id, ...info(comp), allDay: false, start, end };
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

  /** `jumpAhead: false` walks every series from its start (used by tests to check jumping). */
  constructor(texts: string[], options: { jumpAhead?: boolean } = {}) {
    this.jumpAhead = options.jumpAhead ?? true;
    const singles: Single[] = [];
    let calendars = 0;
    let n = 0;
    for (const t of texts) {
      let parsed: unknown;
      try {
        parsed = ICAL.parse(t);
      } catch {
        throw new CalendarError("This file couldn't be read as a calendar. Check it's an .ics file exported from your calendar.");
      }
      const roots = (Array.isArray(parsed) && typeof parsed[0] === "string" ? [parsed] : (parsed as unknown[])) as unknown[];
      for (const root of roots) {
        const vcal = new ICAL.Component(root as never);
        if (vcal.name !== "vcalendar") continue;
        calendars++;
        const vevents = vcal.getAllSubcomponents("vevent");
        // Overrides of one occurrence of a series, grouped by series UID.
        const overrides = new Map<string, ICALComponent[]>();
        const masters: ICALComponent[] = [];
        for (const ev of vevents) {
          if (ev.hasProperty("recurrence-id")) {
            const uid = text(ev, "uid");
            const list = overrides.get(uid) ?? [];
            list.push(ev);
            overrides.set(uid, list);
          } else if (ev.hasProperty("rrule") || ev.hasProperty("rdate")) {
            masters.push(ev);
          } else if (!isCancelled(ev)) {
            const s = readSingle(ev, `e${n++}`);
            if (s) singles.push(s);
          }
        }
        for (const m of masters) {
          const uid = text(m, "uid");
          if (isCancelled(m)) continue;
          const s = this.readSeries(m, `s${n++}`, overrides.get(uid) ?? []);
          if (s) this.series.push(s);
        }
        // Overrides become ordinary events at their own (possibly moved) time.
        // Orphan overrides (no series in the file) are kept too.
        for (const [, list] of overrides) {
          for (const ov of list) {
            if (isCancelled(ov)) continue;
            const s = readSingle(ov, `e${n++}`);
            if (s) singles.push(s);
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

    let firstDay: number | null = null;
    let lastDay: number | null = null;
    const note = (d: number) => {
      if (firstDay === null || d < firstDay) firstDay = d;
      if (lastDay === null || d > lastDay) lastDay = d;
    };
    for (const s of singles) note(s.allDay ? s.start : dayNumberOfInstant(s.start));
    for (const s of this.series) note(s.allDay ? dateDay(s.dtstart) : dayNumberOfInstant(instant(s.dtstart, s.zone)));
    this.summary = {
      events: singles.length + this.series.length,
      recurring: this.series.length,
      calendars,
      firstDay,
      lastDay,
    };
  }

  private readSeries(comp: ICALComponent, id: string, overrides: ICALComponent[]): Series | null {
    const base = readSingle(comp, id);
    if (!base) return null;
    const dtstart = comp.getFirstPropertyValue("dtstart") as ICALTime;
    const zone = tzidOf(comp, "dtstart");
    const skip = new Set<number>();
    for (const ov of overrides) {
      const rid = ov.getFirstPropertyValue("recurrence-id") as ICALTime | null;
      if (rid && typeof rid === "object" && "year" in rid) {
        skip.add(occurrenceKey(rid, tzidOf(ov, "recurrence-id"), base.allDay));
      }
    }
    // EXDATEs, compared as instants so a UTC EXDATE still matches a zoned series.
    for (const p of comp.getAllProperties("exdate")) {
      const pz = p.getParameter("tzid");
      for (const v of p.getValues() as ICALTime[]) {
        if (v && typeof v === "object" && "year" in v) {
          skip.add(occurrenceKey(v, typeof pz === "string" ? pz : zone, base.allDay));
        }
      }
    }
    // A series can jump ahead (start from a later occurrence) when the rule is
    // a plain repeating pattern: no COUNT (which needs every earlier occurrence),
    // no extra dates, and a start day that exists in every month.
    let jump: Series["jump"] = null;
    const rrules = comp.getAllProperties("rrule");
    if (this.jumpAhead && rrules.length === 1 && !comp.hasProperty("rdate")) {
      const rule = rrules[0].getFirstValue() as InstanceType<typeof ICAL.Recur>;
      const freq = rule?.freq;
      const interval = Math.max(1, Number(rule?.interval) || 1);
      const dayOk = dtstart.day <= 28;
      if (rule && !rule.count && (freq === "DAILY" || freq === "WEEKLY" || ((freq === "MONTHLY" || freq === "YEARLY") && dayOk))) {
        jump = { freq, interval };
      }
    }
    const series: Series = {
      id,
      title: base.title,
      location: base.location,
      allDay: base.allDay,
      component: comp,
      dtstart,
      zone,
      length: base.end - base.start,
      skip,
      jump,
      expansion: null,
      windowStart: -Infinity,
      starts: [],
      done: false,
    };
    this.restart(series, -Infinity);
    return series;
  }

  /**
   * (Re)starts expanding a series so that every occurrence from `from` on will
   * be found: from the series' own start, or, when the rule allows, from a
   * whole number of repeats later (so the pattern lines up exactly).
   */
  private restart(s: Series, from: number): void {
    let anchor = s.dtstart;
    let windowStart = -Infinity;
    if (s.jump && Number.isFinite(from)) {
      // A couple of days' margin covers the gap between the series' time zone and ours.
      const fromDay = (s.allDay ? from : dayNumberOfInstant(from)) - 2;
      const startDay = dateDay(s.dtstart);
      const { freq, interval } = s.jump;
      const t = s.dtstart.clone();
      let moved = false;
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
        // The new anchor itself might not match the rule (the expansion always
        // returns its start), so only trust what comes after it.
        windowStart = occurrenceKey(anchor, s.zone, s.allDay) + 1;
      }
    }
    try {
      s.expansion = new ICAL.RecurExpansion({ component: s.component, dtstart: anchor });
      s.done = false;
    } catch {
      s.expansion = null;
      s.done = true;
    }
    s.windowStart = windowStart;
    s.starts = [];
  }

  /** Makes sure every occurrence starting in [from, to) is known. */
  private ensure(s: Series, from: number, to: number): void {
    const far = s.allDay ? FAR_DAYS : FAR_DAYS * 86400000;
    const known = s.starts.length ? s.starts[s.starts.length - 1] : s.windowStart;
    if (from < s.windowStart || (s.jump && !s.done && known < from - far)) this.restart(s, from);
    while (!s.done) {
      const last = s.starts.length ? s.starts[s.starts.length - 1] : -Infinity;
      if (last >= to) return;
      let next: ICALTime | null = null;
      try {
        next = s.expansion!.next() ?? null;
      } catch {
        next = null;
      }
      if (!next || s.starts.length >= MAX_OCCURRENCES) {
        s.done = true;
        s.expansion = null;
        return;
      }
      const key = occurrenceKey(next, s.zone, s.allDay);
      if (key < s.windowStart) continue;
      // Skipped occurrences are recorded too (and filtered when read), so the
      // expansion always knows how far it has got.
      if (s.starts.length && key < s.starts[s.starts.length - 1]) continue;
      s.starts.push(key);
    }
  }

  /** Everything on one local day (a day number), in the device's time zone. */
  day(dayNum: number): DayEvents {
    const { start: dayStart, end: dayEnd } = dayRange(dayNum);
    const allDay: AllDayItem[] = [];
    const timed: DayEvent[] = [];

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
      if (s.allDay) {
        this.ensure(s, dayNum - s.length + 1, dayNum + 1);
        for (let i = lowerBound(s.starts, dayNum - s.length + 1); i < s.starts.length; i++) {
          const st = s.starts[i];
          if (st > dayNum) break;
          if (s.skip.has(st)) continue;
          addAllDay(`${s.id}-${st}`, s, st, st + Math.max(1, s.length));
        }
      } else {
        this.ensure(s, dayStart - s.length, dayEnd);
        for (let i = lowerBound(s.starts, dayStart - s.length); i < s.starts.length; i++) {
          const st = s.starts[i];
          if (st >= dayEnd) break;
          if (s.skip.has(st)) continue;
          addTimed(`${s.id}-${st}`, s, st, st + s.length);
        }
      }
    }

    timed.sort((a, b) => a.start - b.start || b.end - a.end || a.title.localeCompare(b.title));
    allDay.sort((a, b) => a.firstDay - b.firstDay || a.title.localeCompare(b.title));
    return { day: dayNum, allDay, timed };
  }
}

function dayNumberOfInstant(ms: number): number {
  const d = new Date(ms);
  return dayNumber(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
