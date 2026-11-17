/** Regression tests for round 3 of the adversarial review (calendar parts). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Calendar } from "./calendar";
import { dayNumber } from "./time";

const fixture = (name: string) => readFileSync(new URL(`../test-fixtures/${name}.ics`, import.meta.url), "utf8");
function times(cal: Calendar, y: number, m: number, day: number): string[] {
  const f = (ms: number) => {
    const t = new Date(ms);
    return `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  };
  return cal.day(dayNumber(y, m, day)).timed.map((e) => `${f(e.start)}-${f(e.end)} ${e.title}`);
}

describe("#1 a THISANDFUTURE move is a calendar/clock shift, not elapsed time", () => {
  it("spring: Friday 09:00 moved to Monday 09:00 across the clock change stays 09:00", () => {
    const cal = new Calendar([fixture("business-dst")]);
    expect(times(cal, 2026, 3, 9)).toEqual(["3/9 09:00-3/9 10:00 Monday team meeting"]);
    // Jump straight to later weeks too.
    expect(times(cal, 2026, 3, 23)).toEqual(["3/23 09:00-3/23 10:00 Monday team meeting"]);
    expect(times(cal, 2026, 3, 16)).toEqual(["3/16 09:00-3/16 10:00 Monday team meeting"]);
    expect(times(cal, 2026, 3, 30)).toEqual(["3/30 09:00-3/30 10:00 Monday team meeting"]);
    expect(times(cal, 2026, 4, 6)).toEqual([]); // COUNT=5: Feb 27, then four Mondays
    expect(times(cal, 2026, 3, 27)).toEqual([]); // no Friday left behind
  });

  it("spring: Sunday moved to the Saturday before the change", () => {
    const cal = new Calendar([fixture("range-shift-dst")]);
    expect(times(cal, 2026, 3, 7)).toEqual(["3/7 09:00-3/7 10:00 Now Saturday"]);
    expect(times(cal, 2026, 3, 14)).toEqual(["3/14 09:00-3/14 10:00 Now Saturday"]);
    expect(times(cal, 2026, 3, 21)).toEqual(["3/21 09:00-3/21 10:00 Now Saturday"]);
  });

  it("autumn: Friday 09:00 moved to Monday 09:00 across the change", () => {
    const text = fixture("business-dst")
      .replace("DTSTART;TZID=America/New_York:20260227T090000", "DTSTART;TZID=America/New_York:20261023T090000")
      .replace("DTEND;TZID=America/New_York:20260227T100000", "DTEND;TZID=America/New_York:20261023T100000")
      .replace("RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=America/New_York:20260306T090000", "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=America/New_York:20261030T090000")
      .replace("DTSTART;TZID=America/New_York:20260309T090000", "DTSTART;TZID=America/New_York:20261102T090000")
      .replace("DTEND;TZID=America/New_York:20260309T100000", "DTEND;TZID=America/New_York:20261102T100000");
    const cal = new Calendar([text]);
    expect(times(cal, 2026, 11, 2)).toEqual(["11/2 09:00-11/2 10:00 Monday team meeting"]);
    expect(times(cal, 2026, 11, 16)).toEqual(["11/16 09:00-11/16 10:00 Monday team meeting"]);
    expect(times(cal, 2026, 11, 9)).toEqual(["11/9 09:00-11/9 10:00 Monday team meeting"]);
  });
});

describe("P3: a plain yearly rule starting on 29 February", () => {
  it("repeats on 29 February only, and COUNT counts real ones", () => {
    const cal = new Calendar([fixture("leap-day")]);
    expect(times(cal, 2025, 3, 1)).toEqual([]);
    expect(times(cal, 2028, 2, 29)).toEqual(["2/29 09:00-2/29 10:00 leap-day"]);
    expect(times(cal, 2032, 2, 29)).toEqual(["2/29 09:00-2/29 10:00 leap-day"]);
    expect(times(cal, 2036, 2, 29)).toEqual([]);
  });
});

describe("P3: explicit repeated or skipped times in a zone only the file defines", () => {
  for (const start of ["20261030T013000", "20260308T023000"]) {
    it(`${start} reads the same as the browser-known zone`, () => {
      const custom = new Calendar([fixture(`custom-${start}`)]);
      const iana = new Calendar([fixture(`iana-${start}`)]);
      const days = start.includes("1030") ? [[2026, 10, 31], [2026, 11, 1], [2026, 11, 2]] : [[2026, 3, 8], [2026, 3, 9], [2026, 3, 10]];
      for (const [y, m, day] of days) {
        expect(custom.day(dayNumber(y, m, day)).timed.map((e) => [e.start, e.end])).toEqual(iana.day(dayNumber(y, m, day)).timed.map((e) => [e.start, e.end]));
      }
    });
  }
});
