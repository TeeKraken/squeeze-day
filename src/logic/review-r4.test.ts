/**
 * Round 4: a weekly meeting moved "from here on" across the spring change must
 * keep every later occurrence through the autumn change too, whatever zone
 * the device is in. Checked against ical.js's own range-exception handling.
 */
import { readFileSync } from "node:fs";
import ICAL from "ical.js";
import { afterEach, describe, expect, it } from "vitest";
import { Calendar } from "./calendar";
import { dayRange, localDayNumber } from "./time";

const fixture = (name: string) => readFileSync(new URL(`../test-fixtures/${name}.ics`, import.meta.url), "utf8");
const base = fixture("business-dst"); // Friday 09:00 NY from 27 Feb 2026, moved to Mondays from 6 March

/** The same series at another clock time, without COUNT, so it runs through the autumn change. */
function series(start: string, end: string): string {
  return base.replaceAll("T090000", `T${start}`).replaceAll("T100000", `T${end}`).replace(";COUNT=5", "");
}

/** Every occurrence start (ms) until mid-2027, the way ical.js applies the range exception. */
function reference(text: string): number[] {
  const root = new ICAL.Component(ICAL.parse(text));
  const ev = new ICAL.Event(root.getFirstSubcomponent("vevent")!);
  const it = ev.iterator();
  const out: number[] = [];
  for (let t = it.next(); t && out.length < 75; t = it.next()) out.push(ev.getOccurrenceDetails(t).startDate.toJSDate().getTime());
  return out;
}

const original = process.env.TZ;
afterEach(() => {
  process.env.TZ = original;
});

describe("THISANDFUTURE search bounds across both clock changes (review r4)", () => {
  const cases: [string, string, string][] = [
    ["America/New_York", "001500", "004500"], // starts just after midnight
    ["America/New_York", "233000", "234500"], // ends just before midnight
    ["Australia/Brisbane", "091500", "094500"], // NY morning = Brisbane just after midnight
    ["Australia/Brisbane", "080000", "083000"], // NY morning = Brisbane late evening
    ["Europe/London", "091500", "094500"],
  ];
  for (const [zone, start, end] of cases) {
    it(`device in ${zone}, meeting ${start.slice(0, 4)}`, () => {
      process.env.TZ = zone;
      const text = series(start, end);
      const expected = reference(text);
      expect(expected.length).toBeGreaterThan(60);
      for (const jumpAhead of [true, false]) {
        // Forwards, then backwards, then jumping straight to each day (fresh calendar each time).
        const forwards = new Calendar([text], { jumpAhead });
        const backwards = new Calendar([text], { jumpAhead });
        const days = expected.map((ms) => localDayNumber(new Date(ms)));
        const found = (cal: Calendar, day: number) => cal.day(day).timed.map((e) => e.start);
        for (let i = 0; i < expected.length; i++) expect(found(forwards, days[i])).toContain(expected[i]);
        for (let i = expected.length - 1; i >= 0; i--) expect(found(backwards, days[i])).toContain(expected[i]);
        for (const i of [40, 36, 0, 74, 37, 38]) {
          if (i >= expected.length) continue;
          expect(found(new Calendar([text], { jumpAhead }), days[i])).toContain(expected[i]);
        }
        // And nothing extra: every shown start is a real occurrence.
        const all = new Set(expected);
        for (const day of days) for (const ms of found(forwards, day)) expect(all.has(ms)).toBe(true);
        // The viewed day really contains the start (no off-by-a-day placements).
        for (let i = 0; i < expected.length; i++) {
          const r = dayRange(days[i]);
          expect(expected[i] >= r.start && expected[i] < r.end).toBe(true);
        }
      }
    });
  }

  it("the reviewer's two repro files", () => {
    process.env.TZ = "America/New_York";
    const ny = new Calendar([fixture("range-bounds")]);
    expect(ny.day(localDayNumber(new Date("2026-11-02T05:15:00Z"))).timed.map((e) => e.start)).toEqual([Date.parse("2026-11-02T05:15:00Z")]);
    process.env.TZ = "Australia/Brisbane";
    const bne = new Calendar([fixture("range-bounds-brisbane")]);
    expect(bne.day(localDayNumber(new Date("2026-11-02T14:15:00Z"))).timed.map((e) => e.start)).toEqual([Date.parse("2026-11-02T14:15:00Z")]);
  });
});

describe("P3: a change between all-day and timed is reported", () => {
  it("counts it so the page can warn", () => {
    const cal = new Calendar([fixture("range-kind")]);
    expect(cal.summary.kindChanges).toBe(1);
  });
});
