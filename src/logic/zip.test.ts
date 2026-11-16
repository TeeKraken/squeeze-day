import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isZip, readIcsFromZip, ZipError } from "./zip";

/** Builds a minimal zip archive the way zip tools do (deflate or stored). */
function makeZip(files: { name: string; text: string; store?: boolean }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = enc.encode(f.text);
    const data = f.store ? raw : new Uint8Array(deflateRawSync(raw));
    const method = f.store ? 0 : 8;
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

describe("readIcsFromZip", () => {
  it("unpacks every calendar in a Google Calendar-style export zip", async () => {
    const zip = makeZip([
      { name: "me@example.com.ical/Family_abc.ics", text: "BEGIN:VCALENDAR\nEND:VCALENDAR" },
      { name: "me@example.com.ical/me@example.com.ics", text: "BEGIN:VCALENDAR\nX:1\nEND:VCALENDAR" },
      { name: "__MACOSX/._Family_abc.ics", text: "junk" },
      { name: "readme.txt", text: "hi" },
    ]);
    expect(isZip(zip)).toBe(true);
    const files = await readIcsFromZip(zip);
    expect(files.map((f) => f.name)).toEqual(["Family_abc.ics", "me@example.com.ics"]);
    expect(files[1].text).toContain("X:1");
  });

  it("reads stored (uncompressed) entries", async () => {
    const [f] = await readIcsFromZip(makeZip([{ name: "a.ics", text: "BEGIN:VCALENDAR", store: true }]));
    expect(f.text).toBe("BEGIN:VCALENDAR");
  });

  it("explains when there's no calendar inside", async () => {
    await expect(readIcsFromZip(makeZip([{ name: "README.txt", text: "hi" }]))).rejects.toThrow(ZipError);
  });

  it("explains when the zip is damaged", async () => {
    const zip = makeZip([{ name: "a.ics", text: "x" }]).slice(0, 20);
    await expect(readIcsFromZip(zip)).rejects.toThrow(/damaged/);
  });

  it("doesn't mistake a calendar file for a zip", () => {
    expect(isZip(new TextEncoder().encode("BEGIN:VCALENDAR"))).toBe(false);
  });
});
