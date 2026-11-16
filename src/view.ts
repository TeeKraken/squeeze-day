/**
 * Draws one day: the all-day row and the squeezed timeline. All text from the
 * calendar goes in as text, never as HTML.
 */
import type { AllDayItem, DayEvent, DayEvents } from "./logic/calendar";
import { freeLabel, layoutDay, positionOf, type Block } from "./logic/layout";
import { dayNumberToDate, dayRange } from "./logic/time";

type Child = Node | string | null | false | undefined;

/** Creates an element. Text is always set as text, never as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) {
    if (c === null || c === false || c === undefined) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const shortDayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

export const formatTime = (ms: number) => timeFmt.format(ms);

export function dayDate(dayNum: number): Date {
  const d = dayNumberToDate(dayNum);
  return new Date(d.year, d.month - 1, d.day);
}

export function formatDay(dayNum: number): string {
  return dayFmt.format(dayDate(dayNum));
}

const monthYearFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
export function formatMonthYear(dayNum: number): string {
  return monthYearFmt.format(dayDate(dayNum));
}

export function formatShortDay(dayNum: number): string {
  return shortDayFmt.format(dayDate(dayNum));
}

/** "9:20 – 10:00 AM", with a note when it started before or runs past this day. */
export function timeRange(ev: { start: number; end: number }, dayStart: number, dayEnd: number): string {
  const from = ev.start < dayStart ? `From ${shortDayFmt.format(ev.start)}, ${formatTime(ev.start)}` : formatTime(ev.start);
  if (ev.end <= ev.start) return from;
  const to = ev.end > dayEnd ? `${shortDayFmt.format(ev.end)}, ${formatTime(ev.end)}` : formatTime(ev.end);
  return `${from} – ${to}`;
}

export interface DrawOptions {
  threshold: number;
  expanded: ReadonlySet<number>;
  onOpenGap: (start: number) => void;
  onCloseGap: (start: number) => void;
  onEvent: (ev: DayEvent | AllDayItem) => void;
}

/** Pixels per minute for things drawn to scale (72 px an hour). */
export const SCALE = 1.2;
/** Room an appointment needs for its time and one or two lines of title. */
export const MIN_EVENT_HEIGHT = 58;
// Sizes (px) matching style.css: button padding, time line, title line.
const EV_PAD = 8;
const TIME_LINE = 15;
const TITLE_LINE = 17;

function minutesLabel(start: number, end: number, dayStart: number): string {
  return `${formatTime(dayStart + start * 60000)} to ${formatTime(dayStart + end * 60000)}`;
}

export function drawAllDay(list: HTMLElement, wrap: HTMLElement, day: DayEvents, opts: DrawOptions): void {
  list.replaceChildren();
  wrap.hidden = day.allDay.length === 0;
  for (const item of day.allDay) {
    let note = "";
    if (item.timed) note = "all day";
    else if (item.lastDay > item.firstDay) note = `day ${day.day - item.firstDay + 1} of ${item.lastDay - item.firstDay + 1}`;
    const btn = h("button", { type: "button", class: "chip" }, h("span", { class: "chip-title" }, item.title), note ? h("span", { class: "chip-note" }, note) : null);
    btn.addEventListener("click", () => opts.onEvent(item));
    list.append(h("li", {}, btn));
  }
}

export function drawTimeline(ol: HTMLElement, day: DayEvents, opts: DrawOptions): void {
  const { start: dayStart, end: dayEnd } = dayRange(day.day);
  const dayMinutes = (dayEnd - dayStart) / 60000;
  const byId = new Map(day.timed.map((e) => [e.id, e]));
  const layout = layoutDay(
    day.timed.map((e) => ({ id: e.id, start: (e.start - dayStart) / 60000, end: (e.end - dayStart) / 60000 })),
    { dayMinutes, threshold: opts.threshold, scale: SCALE, minEventHeight: MIN_EVENT_HEIGHT, expanded: opts.expanded },
  );
  ol.replaceChildren();
  ol.style.height = `${Math.ceil(layout.height)}px`;

  // Hour marks in the left gutter, only where time is drawn to scale.
  const marks = h("li", { class: "marks", "aria-hidden": "true" });
  let lastY = -Infinity;
  const folds = layout.blocks.filter((b) => b.kind === "squeezed");
  const nearFold = (y: number) => folds.some((f) => y > f.top - 10 && y < f.top + f.height + 10);
  for (let m = 60; m < dayMinutes; m += 60) {
    const y = positionOf(layout, m);
    if (y === null || y - lastY < 18 || layout.height - y < 10 || nearFold(y)) continue;
    const mark = h("span", { class: "mark" }, hourFmt.format(dayStart + m * 60000));
    mark.style.top = `${y}px`;
    marks.append(mark);
    lastY = y;
  }
  ol.append(marks);

  for (const b of layout.blocks) ol.append(block(b, byId, dayStart, dayEnd, opts));
}

function place(el: HTMLElement, b: Block): void {
  el.style.top = `${b.top}px`;
  el.style.height = `${b.height}px`;
}

function block(b: Block, byId: Map<string, DayEvent>, dayStart: number, dayEnd: number, opts: DrawOptions): HTMLElement {
  if (b.kind === "squeezed") {
    const times = minutesLabel(b.start, b.end, dayStart);
    const btn = h(
      "button",
      { type: "button", class: "fold-btn", "aria-label": `${b.label}, ${times}. Open to full size.` },
      h("span", { class: "fold-label" }, b.label),
      h("span", { class: "fold-times" }, `${formatTime(dayStart + b.start * 60000)} – ${formatTime(dayStart + b.end * 60000)}`),
    );
    btn.addEventListener("click", () => opts.onOpenGap(b.start));
    const li = h("li", { class: "fold", "data-fold": String(b.start) }, btn);
    place(li, b);
    return li;
  }
  if (b.kind === "gap") {
    const li = h("li", { class: b.expanded ? "gap gap-open" : "gap", "data-gap": String(b.start) });
    place(li, b);
    const mins = b.end - b.start;
    if (b.expanded) {
      const btn = h("button", { type: "button", class: "btn btn-small squeeze-btn", "aria-label": `${freeLabel(mins)}, ${minutesLabel(b.start, b.end, dayStart)}. Squeeze it again.` }, `${freeLabel(mins)} · Squeeze`);
      btn.addEventListener("click", () => opts.onCloseGap(b.start));
      li.append(btn);
    } else if (b.height >= 16 && mins >= 10) {
      li.append(h("span", { class: "gap-label" }, freeLabel(mins)));
    } else {
      li.setAttribute("aria-hidden", "true");
    }
    return li;
  }
  const ev = byId.get(b.id)!;
  const when = timeRange(ev, dayStart, dayEnd);
  const btn = h(
    "button",
    { type: "button", class: "ev-btn", "aria-label": `${when}: ${ev.title}${ev.location ? `, ${ev.location}` : ""}` },
    h("span", { class: "ev-time", "aria-hidden": "true" }, when, ev.location ? h("span", { class: "ev-where" }, ` · ${ev.location}`) : null),
    h("span", { class: "ev-title", "aria-hidden": "true" }, ev.title),
  );
  // As many title lines as fit, so a title is never cut through the middle.
  const lines = Math.max(1, Math.min(4, Math.floor((b.height - 1 - EV_PAD - TIME_LINE) / TITLE_LINE)));
  btn.style.setProperty("--lines", String(lines));
  btn.addEventListener("click", () => opts.onEvent(ev));
  const li = h("li", { class: b.columns > 1 ? "ev ev-side" : "ev" }, btn);
  place(li, b);
  li.style.setProperty("--col", String(b.column));
  li.style.setProperty("--cols", String(b.columns));
  if (ev.start < dayStart) li.classList.add("ev-from-before");
  if (ev.end > dayEnd) li.classList.add("ev-runs-on");
  return li;
}
