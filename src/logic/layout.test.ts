import { describe, expect, it } from "vitest";
import { freeLabel, layoutDay, positionOf, type Block, type LayoutEvent } from "./layout";

const H = 60;
const ev = (id: string, start: number, end: number): LayoutEvent => ({ id, start, end });
const opts = { scale: 1, minEventHeight: 40, squeezedHeight: 30, threshold: 60 };
const events = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { kind: "event" }> => b.kind === "event");
const free = (blocks: Block[]) => blocks.filter((b) => b.kind !== "event");

/** No two blocks in the same column (or full width gaps) overlap, and gaps never overlap events. */
function expectNoOverlap(blocks: Block[]) {
  const evs = events(blocks);
  for (const a of evs) {
    for (const b of evs) {
      if (a === b) continue;
      const sameColumn = a.columns === b.columns && a.column === b.column;
      if (sameColumn) expect(a.top + a.height <= b.top + 1e-9 || b.top + b.height <= a.top + 1e-9).toBe(true);
    }
    for (const g of free(blocks)) {
      expect(a.top + a.height <= g.top + 1e-9 || g.top + g.height <= a.top + 1e-9).toBe(true);
    }
  }
}

describe("freeLabel", () => {
  it("says how long the free stretch is", () => {
    expect(freeLabel(45)).toBe("45 min free");
    expect(freeLabel(60)).toBe("1 h free");
    expect(freeLabel(150)).toBe("2 h 30 free");
    expect(freeLabel(65)).toBe("1 h 05 free");
    expect(freeLabel(1440, true)).toBe("Free all day");
  });
});

describe("layoutDay", () => {
  it("an empty day is one thin strip", () => {
    const l = layoutDay([], opts);
    expect(l.blocks).toEqual([{ kind: "squeezed", start: 0, end: 1440, top: 0, height: 30, label: "Free all day" }]);
    expect(l.height).toBe(30);
  });

  it("squeezes midnight-to-first and last-to-midnight, keeps events to scale", () => {
    const l = layoutDay([ev("a", 9 * H, 10 * H)], opts);
    expect(l.blocks.map((b) => b.kind)).toEqual(["squeezed", "event", "squeezed"]);
    const [before, e, after] = l.blocks;
    expect(before).toMatchObject({ start: 0, end: 540, top: 0, height: 30, label: "9 h free" });
    expect(e).toMatchObject({ top: 30, height: 60, column: 0, columns: 1 });
    expect(after).toMatchObject({ start: 600, end: 1440, top: 90, label: "14 h free" });
    expect(l.height).toBe(120);
  });

  it("a gap exactly at the threshold stays to scale; longer ones squeeze", () => {
    const l = layoutDay([ev("a", 0, 60), ev("b", 120, 180), ev("c", 241, 300)], { ...opts, threshold: 60 });
    const gaps = free(l.blocks).filter((b) => b.end <= 300);
    expect(gaps[0]).toMatchObject({ kind: "gap", start: 60, end: 120, height: 60 });
    expect(gaps[1]).toMatchObject({ kind: "squeezed", start: 180, end: 241, label: "1 h 01 free" });
  });

  it("back to back has no gap; a few minutes apart shows a gap to scale", () => {
    const l = layoutDay([ev("a", 540, 600), ev("b", 600, 660), ev("c", 665, 720)], { ...opts, scale: 2 });
    const [a, b, c] = events(l.blocks);
    expect(b.top).toBe(a.top + a.height);
    expect(c.top - (b.top + b.height)).toBe(10);
    expect(free(l.blocks).find((g) => g.start === 660)).toMatchObject({ kind: "gap", height: 10 });
  });

  it("short appointments get readable height by stretching time, never covering the next one", () => {
    const l = layoutDay([ev("a", 540, 545), ev("b", 545, 550), ev("c", 552, 560)], opts);
    const [a, b, c] = events(l.blocks);
    expect(a.height).toBeGreaterThanOrEqual(40);
    expect(b.height).toBeGreaterThanOrEqual(40);
    expect(c.height).toBeGreaterThanOrEqual(40);
    expect(b.top).toBeGreaterThanOrEqual(a.top + a.height);
    expect(c.top).toBeGreaterThanOrEqual(b.top + b.height + 2); // the 2-minute gap is still there
    expectNoOverlap(l.blocks);
  });

  it("overlapping appointments sit side by side", () => {
    const l = layoutDay([ev("long", 540, 660), ev("x", 570, 600), ev("y", 600, 630), ev("z", 590, 610)], opts);
    const byId = Object.fromEntries(events(l.blocks).map((e) => [e.id, e]));
    expect(byId.long).toMatchObject({ column: 0, columns: 3 });
    expect(byId.x.column).toBe(1);
    expect(byId.z.column).toBe(2);
    expect(byId.y.column).toBe(1); // reuses x's column once x has ended
    expectNoOverlap(l.blocks);
  });

  it("a short event inside a long one makes no false gap", () => {
    const l = layoutDay([ev("long", 540, 720), ev("short", 600, 610)], opts);
    expect(free(l.blocks).map((b) => [b.start, b.end])).toEqual([
      [0, 540],
      [720, 1440],
    ]);
  });

  it("separate clusters get their own column counts", () => {
    const l = layoutDay([ev("a", 540, 600), ev("b", 550, 610), ev("c", 700, 720)], opts);
    const byId = Object.fromEntries(events(l.blocks).map((e) => [e.id, e]));
    expect(byId.a.columns).toBe(2);
    expect(byId.b.columns).toBe(2);
    expect(byId.c.columns).toBe(1);
  });

  it("zero-length and clipped events still show", () => {
    const l = layoutDay([ev("reminder", 600, 600), ev("overnight", -120, 90), ev("late", 1380, 1600)], opts);
    const byId = Object.fromEntries(events(l.blocks).map((e) => [e.id, e]));
    expect(byId.reminder.height).toBeGreaterThanOrEqual(40);
    expect(byId.overnight).toMatchObject({ start: 0, end: 90, top: 0, height: 90 });
    expect(byId.late).toMatchObject({ start: 1380, end: 1440 });
    expect(l.height).toBe(byId.late.top + byId.late.height);
  });

  it("an opened strip is drawn to scale", () => {
    const l = layoutDay([ev("a", 540, 600)], { ...opts, expanded: new Set([0]) });
    expect(l.blocks[0]).toMatchObject({ kind: "gap", start: 0, end: 540, height: 540, expanded: true });
    expect(l.blocks[2]).toMatchObject({ kind: "squeezed", start: 600 });
  });

  it("never squeezes when the threshold is off", () => {
    const l = layoutDay([ev("a", 540, 600)], { ...opts, threshold: Infinity });
    expect(l.blocks.some((b) => b.kind === "squeezed")).toBe(false);
    expect(l.height).toBe(1440);
  });

  it("clock-change days can be 23 or 25 hours", () => {
    const l = layoutDay([ev("a", 1440, 1470)], { ...opts, dayMinutes: 1500 });
    expect(events(l.blocks)[0]).toMatchObject({ start: 1440, end: 1470 });
    expect(free(l.blocks).at(-1)).toMatchObject({ start: 1470, end: 1500, kind: "gap" });
  });

  it("fits far more of a typical day than drawing it all to scale", () => {
    const day = [ev("a", 450, 480), ev("b", 540, 570), ev("c", 900, 945), ev("d", 1080, 1140)];
    const squeezed = layoutDay(day, { scale: 1.2, minEventHeight: 44, squeezedHeight: 30 });
    expect(squeezed.height).toBeLessThan(1440 * 1.2 * 0.4);
  });

  it("positions minutes on the axis, and none inside a squeezed strip", () => {
    const l = layoutDay([ev("a", 540, 600), ev("b", 630, 660)], opts);
    expect(positionOf(l, 300)).toBeNull();
    expect(positionOf(l, 540)).toBe(30);
    expect(positionOf(l, 570)).toBe(60);
    expect(positionOf(l, 615)).toBe(105);
  });

  it("a timed event covering the whole day blocks the time: never 'Free all day' (review #3)", () => {
    const l = layoutDay([], { ...opts, covered: [{ start: -60, end: 1500, title: "Conference" }] });
    expect(l.blocks).toEqual([{ kind: "squeezed", start: 0, end: 1440, top: 0, height: 30, label: "All day · Conference", covered: "Conference" }]);
  });

  it("covered time around a shorter appointment isn't called free (review #3)", () => {
    const l = layoutDay([ev("call", 600, 630)], { ...opts, covered: [{ start: 0, end: 1440, title: "Trip" }] });
    const strips = free(l.blocks);
    expect(strips.map((b) => (b.kind === "squeezed" ? b.label : "gap"))).toEqual(["10 h · Trip", "13 h 30 · Trip"]);
    expect(strips.every((b) => b.covered === "Trip")).toBe(true);
    expect(l.blocks.some((b) => b.kind === "squeezed" && b.label.includes("free"))).toBe(false);
  });

  it("free time next to covered time stays free and separate", () => {
    const l = layoutDay([], { ...opts, covered: [{ start: 0, end: 600, title: "Flight" }] });
    expect(free(l.blocks).map((b) => (b.kind === "squeezed" ? b.label : ""))).toEqual(["10 h · Flight", "14 h free"]);
  });

  it("side-by-side appointments get their own, taller minimum (review #9)", () => {
    const l = layoutDay([ev("a", 660, 720), ev("b", 690, 750), ev("c", 705, 780), ev("solo", 900, 905)], { ...opts, minSideHeight: 80 });
    for (const e of events(l.blocks)) expect(e.height).toBeGreaterThanOrEqual(e.columns > 1 ? 80 : 40);
    expectNoOverlap(l.blocks);
  });
});
