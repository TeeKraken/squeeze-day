/**
 * Regression tests for round 2 of the adversarial review (calendar parts).
 * The .ics files in src/test-fixtures are the reviewer's repro files.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Calendar, CalendarError } from "./calendar";
import { dayNumber } from "./time";

const fixture = (name: string) => readFileSync(new URL(`../test-fixtures/${name}.ics`, import.meta.url), "utf8");
const d = (y: number, m: number, day: number) => dayNumber(y, m, day);
/** "Mon 23:00-Tue 02:00 title" style entries for each timed event on a day, in New York time. */
function times(cal: Calendar, y: number, m: number, day: number): string[] {
  const f = (ms: number) => {
    const t = new Date(ms);
    return `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  };
  return cal.day(d(y, m, day)).timed.map((e) => `${f(e.start)}-${f(e.end)} ${e.title}`);
}
const allDay = (cal: Calendar, y: number, m: number, day: number) => cal.day(d(y, m, day)).allDay.map((a) => a.title);

describe("#2 a THISANDFUTURE change that makes occurrences longer", () => {
  it("timed: the later occurrence still shows on the next morning", () => {
    const cal = new Calendar([fixture("range-overnight")]);
    expect(times(cal, 2026, 11, 16)).toEqual(["11/16 23:00-11/17 02:00 Longer"]);
    expect(times(cal, 2026, 11, 17)).toEqual(["11/16 23:00-11/17 02:00 Longer"]);
    expect(times(cal, 2026, 11, 23)).toEqual(["11/23 23:00-11/24 02:00 Longer"]);
    expect(times(cal, 2026, 11, 24)).toEqual(["11/23 23:00-11/24 02:00 Longer"]);
  });

  it("all-day: a one-day event made three days long covers all three days every week", () => {
    const cal = new Calendar([fixture("range-all-day")]);
    for (const day of [16, 17, 18]) expect(allDay(cal, 2026, 11, day)).toEqual(["Longer"]);
    expect(allDay(cal, 2026, 11, 19)).toEqual([]);
    expect(allDay(cal, 2026, 11, 2)).toEqual(["Original"]);
    expect(allDay(cal, 2026, 11, 3)).toEqual([]);
  });

  it("a change moving occurrences earlier (to the evening before)", () => {
    const cal = new Calendar([fixture("negative-range")]);
    expect(times(cal, 2026, 11, 16)).toEqual(["11/15 23:00-11/16 02:00 Busy"]);
    expect(times(cal, 2026, 11, 15)).toEqual(["11/15 23:00-11/16 02:00 Busy"]);
  });
});

describe("#4 an RDATE PERIOD at the same start as another occurrence", () => {
  it("its own end wins over the RRULE's length", () => {
    const cal = new Calendar([fixture("rdate-period-collision")]);
    expect(times(cal, 2026, 11, 16)).toEqual(["11/16 04:00-11/16 05:00 Period overlap"]);
    expect(times(cal, 2026, 11, 17)).toEqual(["11/17 04:00-11/17 07:00 Period overlap"]);
    expect(times(cal, 2026, 11, 18)).toEqual(["11/18 04:00-11/18 05:00 Period overlap"]);
  });

  it("its own end wins over the DTSTART occurrence's length too", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:p",
      "SUMMARY:Start",
      "DTSTART:20261116T090000Z",
      "DURATION:PT1H",
      "RDATE;VALUE=PERIOD:20261116T090000Z/PT4H",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(times(new Calendar([ics]), 2026, 11, 16)).toEqual(["11/16 04:00-11/16 08:00 Start"]);
  });
});

describe("#5 a THISANDFUTURE change keeps day-long DURATIONs nominal", () => {
  it("only the title changes: each day still ends at noon across the clock change", () => {
    const cal = new Calendar([fixture("range-nominal-isolated")]);
    expect(times(cal, 2026, 3, 8)).toEqual(["3/7 12:00-3/8 12:00 Changed name", "3/8 12:00-3/9 12:00 Changed name"]);
  });

  it("an hour-long series changed to P1D", () => {
    const cal = new Calendar([fixture("range-nominal")]);
    expect(times(cal, 2026, 3, 8)).toEqual(["3/7 12:00-3/8 12:00 Nominal day", "3/8 12:00-3/9 12:00 Nominal day"]);
  });
});

describe("#6 an RDATE PERIOD with a start and an hour duration is elapsed time", () => {
  it("spring: 01:30 + 2 hours ends at 04:30 (clocks jumped)", () => {
    const cal = new Calendar([fixture("rdate-period-dst-hours")]);
    const [e] = cal.day(d(2026, 3, 8)).timed;
    expect(e.end - e.start).toBe(2 * 3600000);
    expect(times(cal, 2026, 3, 8)).toEqual(["3/8 01:30-3/8 04:30 Period duration"]);
  });

  it("autumn: 00:30 + 2 hours ends at the second 01:30", () => {
    const cal = new Calendar([fixture("rdate-period-fall")]);
    const [e] = cal.day(d(2026, 11, 1)).timed;
    expect(e.end - e.start).toBe(2 * 3600000);
  });
});

describe("#7 skipped hours in zones only the file defines (like Outlook's)", () => {
  it("a renamed copy of New York's definition behaves like New York", () => {
    const cal = new Calendar([fixture("custom-skipped-hour")]);
    expect(times(cal, 2026, 3, 7)).toEqual(["3/7 02:30-3/7 02:45 Early"]);
    expect(times(cal, 2026, 3, 8)).toEqual([]);
    expect(times(cal, 2026, 3, 9)).toEqual(["3/9 02:30-3/9 02:45 Early"]);
    expect(times(cal, 2026, 3, 10)).toEqual(["3/10 02:30-3/10 02:45 Early"]);
    expect(times(cal, 2026, 3, 11)).toEqual([]);
  });

  it("converts ordinary times and both sides of the autumn change correctly", () => {
    const text = fixture("custom-skipped-hour")
      .replace("DTSTART;TZID=Custom/Eastern:20260307T023000", "DTSTART;TZID=Custom/Eastern:20261030T013000")
      .replace("COUNT=3", "COUNT=4");
    const cal = new Calendar([text]);
    expect(times(cal, 2026, 10, 31)).toEqual(["10/31 01:30-10/31 01:45 Early"]);
    const nov1 = cal.day(d(2026, 11, 1)).timed;
    expect(nov1).toHaveLength(1);
    expect(new Date(nov1[0].start).getHours()).toBe(1);
    expect(times(cal, 2026, 11, 2)).toEqual(["11/2 01:30-11/2 01:45 Early"]);
  });

  it("a weekly series whose occurrence lands in the skipped hour", () => {
    const cal = new Calendar([fixture("weekly-skipped-only")]);
    expect(times(cal, 2026, 3, 1)).toEqual(["3/1 02:30-3/1 02:45 Busy"]);
    expect(times(cal, 2026, 3, 8)).toEqual([]);
    expect(times(cal, 2026, 3, 15)).toEqual(["3/15 02:30-3/15 02:45 Busy"]);
  });
});

describe("#8 a file whose every event failed", () => {
  it("is an error, so it can't replace a working calendar", () => {
    expect(() => new Calendar([fixture("unreadable-all")])).toThrow(CalendarError);
  });

  it("an honestly empty calendar is still fine", () => {
    const cal = new Calendar(["BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR"]);
    expect(cal.summary).toEqual({ events: 0, recurring: 0, calendars: 1, unreadable: 0 });
  });
});
