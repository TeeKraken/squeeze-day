import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Calendar } from "./logic/calendar";
import { layoutDay } from "./logic/layout";
import { dayNumber, dayRange } from "./logic/time";

const text = readFileSync(new URL("../public/sample-calendar.ics", import.meta.url), "utf8");

describe("the sample calendar", () => {
  const cal = new Calendar([text]);

  it("has a showcase day with back-to-back, a short gap, long gaps and an overlap", () => {
    const day = cal.day(dayNumber(2026, 11, 17));
    expect(day.allDay.map((e) => e.title)).toEqual(["Grandma Rosa's birthday", "Recycling goes out"]);
    expect(day.timed.map((e) => e.title)).toEqual([
      "Morning walk with Biscuit",
      "School drop-off",
      "Team check-in",
      "Call the plumber about the leak",
      "Lunch with Priya",
      "Leo's swimming lesson",
      "Video call with Mum",
      "Choir practice",
    ]);
    const { start } = dayRange(day.day);
    const l = layoutDay(day.timed.map((e) => ({ id: e.id, start: (e.start - start) / 60000, end: (e.end - start) / 60000 })));
    expect(l.blocks.filter((b) => b.kind === "squeezed").map((b) => (b.kind === "squeezed" ? b.label : ""))).toEqual([
      "7 h free",
      "2 h 30 free",
      "2 h free",
      "2 h free",
      "4 h free",
    ]);
  });

  it("shows the moved and the skipped choir practice", () => {
    expect(cal.day(dayNumber(2026, 11, 24)).timed.map((e) => e.title)).toContain("Choir: concert run-through");
    expect(cal.day(dayNumber(2026, 11, 24)).timed.map((e) => e.title)).not.toContain("Choir practice");
    expect(cal.day(dayNumber(2026, 12, 22)).timed.map((e) => e.title)).not.toContain("Choir practice");
    expect(cal.day(dayNumber(2026, 11, 21)).timed.map((e) => e.title)).toContain("Late film with Jo");
  });
});
