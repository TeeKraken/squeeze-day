/**
 * Regression tests for round 1 of the adversarial review. The .ics files in
 * src/test-fixtures are the reviewer's own repro files.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Calendar } from "./calendar";
import { dayNumber } from "./time";

const fixture = (name: string) => readFileSync(new URL(`../test-fixtures/${name}.ics`, import.meta.url), "utf8");
const d = (y: number, m: number, day: number) => dayNumber(y, m, day);
const local = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min).getTime();
/** "HH:MM-HH:MM title" for each timed event on a day, in New York time. */
function times(cal: Calendar, y: number, m: number, day: number): string[] {
  const hm = (ms: number) => {
    const t = new Date(ms);
    return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  };
  return cal.day(d(y, m, day)).timed.map((e) => `${hm(e.start)}-${hm(e.end)} ${e.title}`);
}
const ics = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
const vevent = (lines: string) => ["BEGIN:VEVENT", ...lines.trim().split("\n").map((l) => l.trim()), "END:VEVENT"].join("\r\n");

describe("#1 UNTIL and EXDATE are compared as real instants, without a zone definition", () => {
  it("positive offset (Tokyo): the occurrence exactly at UNTIL is kept", () => {
    const cal = new Calendar([fixture("until-tokyo")]);
    expect(times(cal, 2026, 11, 14)).toEqual(["19:00-20:00 Tokyo until"]);
    expect(times(cal, 2026, 11, 16)).toEqual(["19:00-20:00 Tokyo until"]);
    expect(times(cal, 2026, 11, 17)).toEqual([]);
  });

  it("negative offset (Los Angeles): the cut-off is inclusive", () => {
    const cal = new Calendar([fixture("until-la")]);
    expect(times(cal, 2026, 11, 15)).toEqual(["20:00-21:00 LA until"]);
    expect(times(cal, 2026, 11, 16)).toEqual(["20:00-21:00 LA until"]);
    expect(times(cal, 2026, 11, 17)).toEqual([]);
  });

  it("negative offset (Los Angeles): nothing after the cut-off", () => {
    const cal = new Calendar([fixture("until-la-early")]);
    expect(times(cal, 2026, 11, 15)).toEqual(["20:00-21:00 LA until"]);
    expect(times(cal, 2026, 11, 16)).toEqual([]);
  });

  it("an EXDATE removes only the occurrence at that instant", () => {
    for (const name of ["exdate-two-times", "exdate-two-times-vtz"]) {
      const cal = new Calendar([fixture(name)]);
      expect(times(cal, 2026, 11, 16)).toEqual(["09:00-09:30 Two calls", "14:00-14:30 Two calls"]);
      expect(times(cal, 2026, 11, 17)).toEqual(["14:00-14:30 Two calls"]);
      expect(times(cal, 2026, 11, 18)).toEqual(["09:00-09:30 Two calls", "14:00-14:30 Two calls"]);
    }
  });

  it("an EXDATE matching no occurrence removes nothing", () => {
    const cal = new Calendar([fixture("exdate-collision")]);
    for (const day of [16, 17, 18]) expect(times(cal, 2026, 11, day)).toEqual(["09:00-10:00 Weekly"]);
  });
});

describe("#4 RDATE is a proper recurrence set", () => {
  it("keeps the DTSTART occurrence alongside RDATEs", () => {
    const cal = new Calendar([fixture("rdate-simple")]);
    expect(times(cal, 2026, 11, 16)).toEqual(["09:00-10:00 Two visits"]);
    expect(times(cal, 2026, 11, 17)).toEqual(["09:00-10:00 Two visits"]);
  });

  it("reads each RDATE in its own zone", () => {
    const cal = new Calendar([fixture("rdate-zones")]);
    expect(times(cal, 2026, 11, 16)).toEqual(["09:00-10:00 Other zone", "19:00-20:00 Other zone"]);
    expect(times(cal, 2026, 11, 17)).toEqual([]);
  });

  it("PERIOD values carry their own length", () => {
    const cal = new Calendar([fixture("rdate-period")]);
    expect(times(cal, 2026, 11, 16)).toEqual(["04:00-05:00 Period"]);
    expect(times(cal, 2026, 11, 17)).toEqual(["04:00-07:00 Period"]);
    expect(cal.summary.unreadable).toBe(0);
  });

  it("RRULE and RDATE together, with duplicates shown once and EXDATE applied to both", () => {
    const cal = new Calendar([
      ics(vevent(`UID:m\nSUMMARY:Mix\nDTSTART:20261116T090000\nDURATION:PT1H\nRRULE:FREQ=DAILY;COUNT=2\nRDATE:20261117T090000,20261120T090000,20261121T090000\nEXDATE:20261121T090000`)),
    ]);
    expect(times(cal, 2026, 11, 16)).toEqual(["09:00-10:00 Mix"]);
    expect(times(cal, 2026, 11, 17)).toEqual(["09:00-10:00 Mix"]);
    expect(times(cal, 2026, 11, 18)).toEqual([]);
    expect(times(cal, 2026, 11, 20)).toEqual(["09:00-10:00 Mix"]);
    expect(times(cal, 2026, 11, 21)).toEqual([]);
  });

  it("a repeat rule it can't follow is counted as unreadable, not shown as empty success", () => {
    const cal = new Calendar([
      ics(
        vevent(`UID:b\nSUMMARY:Broken\nDTSTART:20261116T090000\nRRULE:FREQ=SOMETIMES`),
        vevent(`UID:c\nSUMMARY:No frequency\nDTSTART:20261116T100000\nRRULE:INTERVAL=2`),
        vevent(`UID:ok\nSUMMARY:Fine\nDTSTART:20261116T110000\nDURATION:PT1H`),
      ),
    ]);
    expect(cal.summary.unreadable).toBe(2);
    expect(cal.summary.recurring).toBe(0);
    expect(times(cal, 2026, 11, 16)).toEqual(["11:00-12:00 Fine"]);
  });
});

describe("#5 RANGE=THISANDFUTURE", () => {
  it("moves this and every later occurrence", () => {
    const cal = new Calendar([fixture("future-override")]);
    expect(times(cal, 2026, 11, 16)).toEqual(["09:00-10:00 Weekly original"]);
    expect(times(cal, 2026, 11, 23)).toEqual(["11:00-12:00 Weekly moved"]);
    expect(times(cal, 2026, 11, 30)).toEqual(["11:00-12:00 Weekly moved"]);
    expect(times(cal, 2026, 12, 7)).toEqual(["11:00-12:00 Weekly moved"]);
    expect(times(cal, 2026, 12, 14)).toEqual([]); // COUNT=4 still ends the series
  });

  it("a later single change still wins, and a cancelled range ends the series", () => {
    const cal = new Calendar([
      ics(
        vevent(`UID:w\nSUMMARY:Club\nDTSTART:20261102T180000\nDURATION:PT1H\nRRULE:FREQ=WEEKLY`),
        vevent(`UID:w\nSUMMARY:Club (new time)\nRECURRENCE-ID;RANGE=THISANDFUTURE:20261109T180000\nDTSTART:20261109T190000\nDURATION:PT2H`),
        vevent(`UID:w\nSUMMARY:Club (one-off)\nRECURRENCE-ID:20261116T180000\nDTSTART:20261116T170000\nDURATION:PT1H`),
        vevent(`UID:w\nSUMMARY:Club\nSTATUS:CANCELLED\nRECURRENCE-ID;RANGE=THISANDFUTURE:20261130T180000\nDTSTART:20261130T190000\nDURATION:PT2H`),
      ),
    ]);
    expect(times(cal, 2026, 11, 2)).toEqual(["18:00-19:00 Club"]);
    expect(times(cal, 2026, 11, 9)).toEqual(["19:00-21:00 Club (new time)"]);
    expect(times(cal, 2026, 11, 16)).toEqual(["17:00-18:00 Club (one-off)"]);
    expect(times(cal, 2026, 11, 23)).toEqual(["19:00-21:00 Club (new time)"]);
    expect(times(cal, 2026, 11, 30)).toEqual([]);
    expect(times(cal, 2026, 12, 7)).toEqual([]);
  });
});

describe("#6 day and week DURATIONs keep the clock time across daylight saving", () => {
  it("spring forward: noon + P1D ends at noon, and repeats don't overlap", () => {
    const cal = new Calendar([fixture("duration-day")]);
    const mar8 = cal.day(d(2026, 3, 8)).timed;
    expect(mar8.map((e) => [e.start, e.end])).toEqual([
      [local(2026, 3, 7, 12), local(2026, 3, 8, 12)],
      [local(2026, 3, 8, 12), local(2026, 3, 9, 12)],
    ]);
  });

  it("fall back: a single event with P1DT1H", () => {
    const cal = new Calendar([ics(vevent(`UID:f\nSUMMARY:Long\nDTSTART;TZID=America/New_York:20261031T120000\nDURATION:P1DT1H`))]);
    const [e] = cal.day(d(2026, 11, 1)).timed;
    expect(e.end).toBe(local(2026, 11, 1, 13));
  });

  it("DTEND repeats keep their exact length (as the standard says)", () => {
    const cal = new Calendar([ics(vevent(`UID:x\nSUMMARY:Shift\nDTSTART;TZID=America/New_York:20260307T200000\nDTEND;TZID=America/New_York:20260308T080000\nRRULE:FREQ=DAILY;COUNT=2`))]);
    // 8 PM to 8 AM across the change is 11 real hours; every repeat lasts the same 11 hours.
    const [a] = cal.day(d(2026, 3, 7)).timed;
    expect(a.end - a.start).toBe(11 * 3600000);
    const b = cal.day(d(2026, 3, 8)).timed.find((e) => e.start === local(2026, 3, 8, 20))!;
    expect(b.end).toBe(local(2026, 3, 9, 7));
  });
});

describe("#7 occurrences in the skipped hour are dropped and don't use up COUNT", () => {
  for (const name of ["skipped-hour", "dst-vtz"]) {
    it(name, () => {
      const cal = new Calendar([fixture(name)]);
      const title = name === "dst-vtz" ? "Early" : "Night call";
      expect(times(cal, 2026, 3, 7)).toEqual([`02:30-02:45 ${title}`]);
      expect(times(cal, 2026, 3, 8)).toEqual([]);
      expect(times(cal, 2026, 3, 9)).toEqual([`02:30-02:45 ${title}`]);
      expect(times(cal, 2026, 3, 10)).toEqual([`02:30-02:45 ${title}`]);
      expect(times(cal, 2026, 3, 11)).toEqual([]);
    });
  }

  it("a single event written in the skipped hour still shows (moved forward)", () => {
    const cal = new Calendar([ics(vevent(`UID:s\nSUMMARY:Odd\nDTSTART;TZID=America/New_York:20260308T023000\nDURATION:PT15M`))]);
    expect(times(cal, 2026, 3, 8)).toEqual(["03:30-03:45 Odd"]);
  });
});

describe("#3 timed events covering the whole day", () => {
  it("go in the all-day row with their real times (the view blocks the day with them)", () => {
    const cal = new Calendar([fixture("all-day-busy")]);
    const day = cal.day(d(2026, 11, 16));
    expect(day.timed).toEqual([]);
    expect(day.allDay[0]).toMatchObject({ title: "Conference", timed: { start: local(2026, 11, 16), end: local(2026, 11, 17) } });
  });
});

describe("#11 summary", () => {
  it("doesn't claim a date range", () => {
    const cal = new Calendar([fixture("future-override")]);
    expect(Object.keys(cal.summary).sort()).toEqual(["calendars", "events", "recurring", "unreadable"]);
  });
});
