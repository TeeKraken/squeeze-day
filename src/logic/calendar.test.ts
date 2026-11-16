import { describe, expect, it } from "vitest";
import { Calendar, CalendarError } from "./calendar";
import { dayNumber } from "./time";

const d = (y: number, m: number, day: number) => dayNumber(y, m, day);
const local = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min).getTime();

function ics(...events: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...events, "END:VCALENDAR"].join("\r\n");
}
function vevent(lines: string): string {
  return ["BEGIN:VEVENT", ...lines.trim().split("\n").map((l) => l.trim()), "END:VEVENT"].join("\r\n");
}

const BERLIN = `BEGIN:VTIMEZONE
TZID:Europe/Berlin
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE`.replace(/\n/g, "\r\n");

const CUSTOM_ZONE = `BEGIN:VTIMEZONE
TZID:My office time
BEGIN:STANDARD
TZOFFSETFROM:+0100
TZOFFSETTO:+0100
DTSTART:19700101T000000
END:STANDARD
END:VTIMEZONE`.replace(/\n/g, "\r\n");

function titles(cal: Calendar, day: number) {
  return cal.day(day).timed.map((e) => e.title);
}

describe("the test machine", () => {
  it("runs in New York time, so time zone handling is really exercised", () => {
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(300);
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(240);
  });
});

describe("reading times", () => {
  it("UTC times (Z) become local time", () => {
    const cal = new Calendar([ics(vevent(`UID:a\nSUMMARY:Call\nDTSTART:20260115T150000Z\nDTEND:20260115T160000Z`))]);
    const [e] = cal.day(d(2026, 1, 15)).timed;
    expect(e.start).toBe(local(2026, 1, 15, 10));
    expect(e.end).toBe(local(2026, 1, 15, 11));
  });

  it("TZID times with a time zone definition in the file", () => {
    const cal = new Calendar([
      ics(BERLIN, vevent(`UID:a\nSUMMARY:Berlin\nDTSTART;TZID=Europe/Berlin:20260115T090000\nDTEND;TZID=Europe/Berlin:20260115T100000`)),
    ]);
    const [e] = cal.day(d(2026, 1, 15)).timed;
    expect(e.start).toBe(local(2026, 1, 15, 3));
    expect(e.end).toBe(local(2026, 1, 15, 4));
  });

  it("TZID times without a definition use the browser's zone data", () => {
    const cal = new Calendar([ics(vevent(`UID:a\nSUMMARY:Tokyo\nDTSTART;TZID=Asia/Tokyo:20260116T090000\nDTEND;TZID=Asia/Tokyo:20260116T100000`))]);
    // 09:00 in Tokyo on the 16th is 19:00 on the 15th in New York.
    expect(titles(cal, d(2026, 1, 16))).toEqual([]);
    const [e] = cal.day(d(2026, 1, 15)).timed;
    expect(e.start).toBe(local(2026, 1, 15, 19));
  });

  it("Windows zone names and prefixed zone names", () => {
    const cal = new Calendar([
      ics(
        vevent(`UID:a\nSUMMARY:Windows\nDTSTART;TZID=Pacific Standard Time:20260115T090000\nDTEND;TZID=Pacific Standard Time:20260115T093000`),
        vevent(`UID:b\nSUMMARY:Mozilla\nDTSTART;TZID=/mozilla.org/20050126_1/Europe/London:20260115T090000\nDURATION:PT30M`),
      ),
    ]);
    const evs = cal.day(d(2026, 1, 15)).timed;
    expect(evs.find((e) => e.title === "Windows")!.start).toBe(local(2026, 1, 15, 12));
    const moz = evs.find((e) => e.title === "Mozilla")!;
    expect(moz.start).toBe(local(2026, 1, 15, 4));
    expect(moz.end).toBe(local(2026, 1, 15, 4, 30));
  });

  it("an unknown zone name falls back to its definition in the file", () => {
    const cal = new Calendar([ics(CUSTOM_ZONE, vevent(`UID:a\nSUMMARY:Office\nDTSTART;TZID=My office time:20260115T090000\nDTEND;TZID=My office time:20260115T100000`))]);
    const [e] = cal.day(d(2026, 1, 15)).timed;
    expect(e.start).toBe(local(2026, 1, 15, 3));
  });

  it("floating times (no zone) are read as local clock time", () => {
    const cal = new Calendar([ics(vevent(`UID:a\nSUMMARY:Walk\nDTSTART:20260115T073000\nDTEND:20260115T080000`))]);
    const [e] = cal.day(d(2026, 1, 15)).timed;
    expect(e.start).toBe(local(2026, 1, 15, 7, 30));
  });

  it("all-day events use the exclusive end date", () => {
    const cal = new Calendar([ics(vevent(`UID:a\nSUMMARY:Trip\nDTSTART;VALUE=DATE:20260115\nDTEND;VALUE=DATE:20260117`))]);
    expect(cal.day(d(2026, 1, 14)).allDay).toEqual([]);
    expect(cal.day(d(2026, 1, 15)).allDay.map((e) => e.title)).toEqual(["Trip"]);
    expect(cal.day(d(2026, 1, 16)).allDay.map((e) => e.title)).toEqual(["Trip"]);
    expect(cal.day(d(2026, 1, 17)).allDay).toEqual([]);
    expect(cal.day(d(2026, 1, 15)).timed).toEqual([]);
  });

  it("an all-day event with no end lasts one day", () => {
    const cal = new Calendar([ics(vevent(`UID:a\nSUMMARY:Bins\nDTSTART;VALUE=DATE:20260115`))]);
    expect(cal.day(d(2026, 1, 15)).allDay).toHaveLength(1);
    expect(cal.day(d(2026, 1, 16)).allDay).toHaveLength(0);
  });

  it("events spanning midnight show on both days", () => {
    const cal = new Calendar([ics(vevent(`UID:a\nSUMMARY:Night shift\nDTSTART:20260115T220000\nDTEND:20260116T013000`))]);
    expect(titles(cal, d(2026, 1, 15))).toEqual(["Night shift"]);
    expect(titles(cal, d(2026, 1, 16))).toEqual(["Night shift"]);
    expect(titles(cal, d(2026, 1, 17))).toEqual([]);
    expect(cal.day(d(2026, 1, 16)).timed[0].start).toBe(local(2026, 1, 15, 22));
  });

  it("an event ending exactly at midnight doesn't show the next day", () => {
    const cal = new Calendar([ics(vevent(`UID:a\nSUMMARY:Late\nDTSTART:20260115T230000\nDTEND:20260116T000000`))]);
    expect(titles(cal, d(2026, 1, 16))).toEqual([]);
  });

  it("a timed event covering the whole day goes in the all-day row", () => {
    const cal = new Calendar([ics(vevent(`UID:a\nSUMMARY:Conference\nDTSTART:20260115T080000\nDTEND:20260118T170000`))]);
    const day = cal.day(d(2026, 1, 16));
    expect(day.timed).toEqual([]);
    expect(day.allDay[0].title).toBe("Conference");
    expect(day.allDay[0].timed).toBeDefined();
    expect(titles(cal, d(2026, 1, 15))).toEqual(["Conference"]);
  });

  it("cancelled events and events without a title", () => {
    const cal = new Calendar([
      ics(
        vevent(`UID:a\nSUMMARY:Gone\nSTATUS:CANCELLED\nDTSTART:20260115T090000\nDTEND:20260115T100000`),
        vevent(`UID:b\nDTSTART:20260115T110000\nDTEND:20260115T120000`),
      ),
    ]);
    expect(titles(cal, d(2026, 1, 15))).toEqual(["Busy"]);
  });
});

describe("recurring events", () => {
  it("daily with a count", () => {
    const cal = new Calendar([ics(vevent(`UID:a\nSUMMARY:Walk\nDTSTART:20260112T073000\nDTEND:20260112T080000\nRRULE:FREQ=DAILY;COUNT=5`))]);
    expect(titles(cal, d(2026, 1, 11))).toEqual([]);
    for (let day = 12; day <= 16; day++) expect(titles(cal, d(2026, 1, day))).toEqual(["Walk"]);
    expect(titles(cal, d(2026, 1, 17))).toEqual([]);
    expect(cal.day(d(2026, 1, 14)).timed[0].start).toBe(local(2026, 1, 14, 7, 30));
  });

  const weekly = ics(
    vevent(`UID:w\nSUMMARY:Choir\nDTSTART;TZID=America/New_York:20260112T180000\nDTEND;TZID=America/New_York:20260112T190000
      RRULE:FREQ=WEEKLY;BYDAY=MO,WE
      EXDATE:20260119T230000Z`),
    // Wednesday 21 Jan moved to Thursday 22 Jan, 2pm, with a new title.
    vevent(`UID:w\nSUMMARY:Choir (moved)\nRECURRENCE-ID;TZID=America/New_York:20260121T180000
      DTSTART;TZID=America/New_York:20260122T140000\nDTEND;TZID=America/New_York:20260122T150000`),
    // Monday 26 Jan cancelled.
    vevent(`UID:w\nSUMMARY:Choir\nSTATUS:CANCELLED\nRECURRENCE-ID;TZID=America/New_York:20260126T180000
      DTSTART;TZID=America/New_York:20260126T180000\nDTEND;TZID=America/New_York:20260126T190000`),
  );

  it("weekly with EXDATE (written in UTC), a moved occurrence and a cancelled one", () => {
    const cal = new Calendar([weekly]);
    expect(titles(cal, d(2026, 1, 12))).toEqual(["Choir"]);
    expect(titles(cal, d(2026, 1, 13))).toEqual([]);
    expect(titles(cal, d(2026, 1, 14))).toEqual(["Choir"]);
    expect(titles(cal, d(2026, 1, 19))).toEqual([]); // EXDATE
    expect(titles(cal, d(2026, 1, 21))).toEqual([]); // moved away
    expect(titles(cal, d(2026, 1, 22))).toEqual(["Choir (moved)"]);
    expect(cal.day(d(2026, 1, 22)).timed[0].start).toBe(local(2026, 1, 22, 14));
    expect(titles(cal, d(2026, 1, 26))).toEqual([]); // cancelled
    expect(titles(cal, d(2026, 1, 28))).toEqual(["Choir"]);
  });

  it("gives the same answers when days are viewed out of order", () => {
    const cal = new Calendar([weekly]);
    expect(titles(cal, d(2026, 3, 2))).toEqual(["Choir"]);
    expect(titles(cal, d(2026, 1, 19))).toEqual([]);
    expect(titles(cal, d(2026, 1, 14))).toEqual(["Choir"]);
    expect(titles(cal, d(2026, 1, 12))).toEqual(["Choir"]);
    expect(titles(cal, d(2026, 1, 11))).toEqual([]);
  });

  it("monthly on a day of the month, with an end date", () => {
    const cal = new Calendar([
      ics(vevent(`UID:m\nSUMMARY:Rent\nDTSTART:20260115T090000\nDTEND:20260115T091500\nRRULE:FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20260415T235959Z`)),
    ]);
    expect(titles(cal, d(2026, 2, 15))).toEqual(["Rent"]);
    expect(titles(cal, d(2026, 2, 16))).toEqual([]);
    expect(titles(cal, d(2026, 4, 15))).toEqual(["Rent"]);
    expect(titles(cal, d(2026, 5, 15))).toEqual([]);
  });

  it("monthly on the second Tuesday", () => {
    const cal = new Calendar([ics(vevent(`UID:m\nSUMMARY:Club\nDTSTART:20260113T190000\nDURATION:PT2H\nRRULE:FREQ=MONTHLY;BYDAY=2TU`))]);
    expect(titles(cal, d(2026, 2, 10))).toEqual(["Club"]);
    expect(titles(cal, d(2026, 2, 3))).toEqual([]);
    expect(titles(cal, d(2026, 11, 10))).toEqual(["Club"]);
  });

  it("keeps the local clock time across daylight saving changes", () => {
    const cal = new Calendar([
      ics(
        vevent(`UID:ny\nSUMMARY:Standup\nDTSTART;TZID=America/New_York:20261006T090000\nDTEND;TZID=America/New_York:20261006T091500\nRRULE:FREQ=WEEKLY`),
        vevent(`UID:ldn\nSUMMARY:London call\nDTSTART;TZID=Europe/London:20261006T090000\nDTEND;TZID=Europe/London:20261006T093000\nRRULE:FREQ=WEEKLY`),
      ),
    ]);
    const before = cal.day(d(2026, 10, 20)).timed;
    expect(before.find((e) => e.title === "Standup")!.start).toBe(local(2026, 10, 20, 9));
    expect(before.find((e) => e.title === "London call")!.start).toBe(local(2026, 10, 20, 4));
    // UK clocks changed on 25 Oct, US clocks on 1 Nov.
    const between = cal.day(d(2026, 10, 27)).timed;
    expect(between.find((e) => e.title === "London call")!.start).toBe(local(2026, 10, 27, 5));
    const after = cal.day(d(2026, 11, 3)).timed;
    expect(after.find((e) => e.title === "Standup")!.start).toBe(local(2026, 11, 3, 9));
    expect(after.find((e) => e.title === "London call")!.start).toBe(local(2026, 11, 3, 4));
  });

  it("a recurring event that runs past midnight shows the next morning", () => {
    const cal = new Calendar([ics(vevent(`UID:n\nSUMMARY:Night shift\nDTSTART:20260112T230000\nDTEND:20260113T020000\nRRULE:FREQ=DAILY;COUNT=3`))]);
    expect(titles(cal, d(2026, 1, 15))).toEqual(["Night shift"]); // the tail of the 14th's shift
    expect(titles(cal, d(2026, 1, 16))).toEqual([]);
    expect(cal.day(d(2026, 1, 15)).timed[0].start).toBe(local(2026, 1, 14, 23));
  });

  it("yearly all-day birthdays", () => {
    const cal = new Calendar([ics(vevent(`UID:b\nSUMMARY:Sam's birthday\nDTSTART;VALUE=DATE:19900304\nDTEND;VALUE=DATE:19900305\nRRULE:FREQ=YEARLY`))]);
    expect(cal.day(d(2026, 3, 4)).allDay.map((e) => e.title)).toEqual(["Sam's birthday"]);
    expect(cal.day(d(2026, 3, 5)).allDay).toEqual([]);
  });

  it("weekly all-day with an all-day EXDATE", () => {
    const cal = new Calendar([
      ics(vevent(`UID:r\nSUMMARY:Recycling\nDTSTART;VALUE=DATE:20260106\nRRULE:FREQ=WEEKLY\nEXDATE;VALUE=DATE:20260113`)),
    ]);
    expect(cal.day(d(2026, 1, 6)).allDay).toHaveLength(1);
    expect(cal.day(d(2026, 1, 13)).allDay).toHaveLength(0);
    expect(cal.day(d(2026, 1, 20)).allDay).toHaveLength(1);
  });

  it("an override whose series isn't in the file still shows", () => {
    const cal = new Calendar([
      ics(vevent(`UID:x\nSUMMARY:One I was invited to\nRECURRENCE-ID:20260115T090000Z\nDTSTART:20260115T150000Z\nDTEND:20260115T160000Z`)),
    ]);
    expect(titles(cal, d(2026, 1, 15))).toEqual(["One I was invited to"]);
  });
});

describe("jumping ahead in long series", () => {
  const rules: [string, string][] = [
    ["DTSTART;TZID=Europe/Berlin:20190103T081500\nDTEND;TZID=Europe/Berlin:20190103T090000", "FREQ=DAILY;INTERVAL=3"],
    ["DTSTART;TZID=America/New_York:20190101T234500\nDTEND;TZID=America/New_York:20190102T003000", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH"],
    ["DTSTART:20190108T190000\nDURATION:PT1H", "FREQ=MONTHLY;BYDAY=2TU"],
    ["DTSTART:20190131T190000\nDURATION:PT1H", "FREQ=MONTHLY;BYMONTHDAY=-1"],
    ["DTSTART:20190315T120000Z\nDURATION:PT30M", "FREQ=MONTHLY;INTERVAL=5;BYMONTHDAY=15"],
    ["DTSTART:20190426T170000\nDURATION:PT1H", "FREQ=MONTHLY;BYDAY=-1FR"],
    ["DTSTART;VALUE=DATE:20160229", "FREQ=YEARLY"],
    ["DTSTART;VALUE=DATE:20190704", "FREQ=YEARLY;INTERVAL=2"],
    ["DTSTART;VALUE=DATE:20190107\nDTEND;VALUE=DATE:20190109", "FREQ=WEEKLY;BYDAY=MO;UNTIL=20270101"],
    ["DTSTART:20190101T090000\nDURATION:PT30M", "FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261020T000000Z"],
  ];
  const days: number[] = [];
  for (let i = 0; i < 40; i++) days.push(d(2026, 9, 1) + i * 3);
  days.push(d(2031, 2, 28), d(2019, 1, 9), d(2024, 2, 29), d(2026, 10, 30), d(2026, 10, 2));

  for (const [start, rule] of rules) {
    it(`matches a full walk: ${rule}`, () => {
      const text = ics(vevent(`UID:x\nSUMMARY:X\n${start}\nRRULE:${rule}\nEXDATE:20261009T000000Z`));
      const fast = new Calendar([text]);
      const slow = new Calendar([text], { jumpAhead: false });
      for (const day of days) {
        const a = fast.day(day);
        const b = slow.day(day);
        expect([a.timed, a.allDay]).toEqual([b.timed, b.allDay]);
      }
    });
  }
});

describe("files", () => {
  it("rejects files that aren't calendars", () => {
    expect(() => new Calendar(["name,date\nSam,2026-01-01"])).toThrow(CalendarError);
    expect(() => new Calendar(["BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Sam\r\nEND:VCARD"])).toThrow(CalendarError);
  });

  it("merges several calendars and sums them up", () => {
    const cal = new Calendar([
      ics(vevent(`UID:a\nSUMMARY:A\nDTSTART:20250101T090000\nDTEND:20250101T100000`)),
      ics(vevent(`UID:b\nSUMMARY:B\nDTSTART:20270101T090000\nDTEND:20270101T100000\nRRULE:FREQ=DAILY`)),
    ]);
    expect(cal.summary).toMatchObject({ events: 2, recurring: 1, calendars: 2, firstDay: d(2025, 1, 1), lastDay: d(2027, 1, 1) });
  });

  it("handles a big calendar (years of events) quickly, expanding only what's viewed", () => {
    const events: string[] = [];
    const pad = (n: number) => String(n).padStart(2, "0");
    let uid = 0;
    for (let y = 2014; y <= 2026; y++) {
      for (let m = 1; m <= 12; m++) {
        for (let day = 1; day <= 28; day++) {
          for (const h of [9, 13, 16]) {
            events.push(
              vevent(`UID:${uid++}@example.com\nSUMMARY:Meeting ${uid}\nLOCATION:Room ${uid % 7}\nDESCRIPTION:Agenda: review the plan\, check numbers and agree next steps for the week ahead.\nDTSTAMP:20160101T000000Z\nDTSTART:${y}${pad(m)}${pad(day)}T${pad(h)}0000Z\nDTEND:${y}${pad(m)}${pad(day)}T${pad(h)}4500Z`),
            );
          }
        }
      }
    }
    for (let i = 0; i < 200; i++) {
      events.push(
        vevent(`UID:r${i}\nSUMMARY:Daily ${i}\nDTSTART;TZID=Europe/Berlin:2016${pad((i % 12) + 1)}01T0${i % 10}0000\nDURATION:PT30M\nRRULE:FREQ=DAILY`),
      );
    }
    const text = ics(BERLIN, ...events);
    expect(text.length).toBeGreaterThan(3_000_000); // several MB, like years of a real calendar;
    let t = performance.now();
    const cal = new Calendar([text]);
    const parseMs = performance.now() - t;
    t = performance.now();
    const day = cal.day(d(2026, 11, 17));
    const firstDayMs = performance.now() - t;
    t = performance.now();
    cal.day(d(2026, 11, 18));
    cal.day(d(2026, 11, 16));
    const nextDaysMs = performance.now() - t;
    expect(day.timed.length).toBe(3 + 200);
    expect(parseMs).toBeLessThan(15000);
    expect(firstDayMs).toBeLessThan(15000);
    expect(nextDaysMs).toBeLessThan(200);
    console.log(`big calendar: ${(text.length / 1e6).toFixed(1)} MB, parse ${parseMs.toFixed(0)} ms, first day ${firstDayMs.toFixed(0)} ms, next two days ${nextDaysMs.toFixed(1)} ms`);
  }, 60000);
});
