/**
 * The squeezed day layout: a pure function from one day's appointments to
 * positioned blocks.
 *
 * Time runs down the page. Busy time and short free gaps are drawn to scale,
 * so "back to back" and "five minutes apart" look different. Free stretches
 * longer than the threshold fold into a thin strip labelled with their length.
 * Every appointment gets at least `minEventHeight` so its time and title stay
 * readable; when one needs more room, the time axis stretches there, so
 * nothing ever covers the block after it. Overlapping appointments sit side by
 * side in columns.
 */

export interface LayoutEvent {
  id: string;
  /** Minutes from the start of the day (may be fractional). */
  start: number;
  end: number;
}

export interface LayoutOptions {
  /** Minutes in this day: 1440, or 1380 / 1500 on clock-change days. */
  dayMinutes?: number;
  /** Free stretches longer than this many minutes are squeezed. Infinity = never. */
  threshold?: number;
  /** Pixels per minute for things drawn to scale. */
  scale?: number;
  minEventHeight?: number;
  squeezedHeight?: number;
  /** Start minutes of squeezed gaps the person has opened back to full size. */
  expanded?: ReadonlySet<number>;
}

export type Block =
  | { kind: "event"; id: string; start: number; end: number; top: number; height: number; column: number; columns: number }
  | { kind: "gap"; start: number; end: number; top: number; height: number; expanded: boolean }
  | { kind: "squeezed"; start: number; end: number; top: number; height: number; label: string };

export interface DayLayout {
  height: number;
  /** Events, gaps and squeezed strips, in time order (events by start, then column). */
  blocks: Block[];
  /** The time axis: every piece of the day with where it sits on the page. */
  axis: { start: number; end: number; top: number; height: number; squeezed: boolean }[];
}

export const DEFAULTS = {
  dayMinutes: 1440,
  threshold: 60,
  scale: 1.2,
  minEventHeight: 44,
  squeezedHeight: 30,
};

/** "45 min free", "3 h free", "2 h 30 free". */
export function freeLabel(minutes: number, wholeDay = false): string {
  if (wholeDay) return "Free all day";
  const m = Math.round(minutes);
  if (m < 60) return `${m} min free`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h free` : `${h} h ${String(rest).padStart(2, "0")} free`;
}

interface Placed {
  id: string;
  start: number;
  end: number;
  /** End used for overlap and spacing: at least one minute after start. */
  effEnd: number;
  column: number;
  columns: number;
}

/** Assigns side-by-side columns to overlapping appointments. */
function assignColumns(events: LayoutEvent[], dayMinutes: number): Placed[] {
  const placed: Placed[] = events
    .map((e) => {
      const start = Math.min(Math.max(0, e.start), dayMinutes - 1);
      const end = Math.min(Math.max(start, e.end), dayMinutes);
      return { id: e.id, start, end, effEnd: Math.max(end, start + 1), column: 0, columns: 1 };
    })
    .sort((a, b) => a.start - b.start || b.effEnd - a.effEnd);

  let cluster: Placed[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -Infinity;
  const close = () => {
    for (const p of cluster) p.columns = colEnds.length;
    cluster = [];
    colEnds = [];
  };
  for (const p of placed) {
    if (p.start >= clusterEnd) close();
    let col = colEnds.findIndex((end) => end <= p.start);
    if (col < 0) {
      col = colEnds.length;
      colEnds.push(p.effEnd);
    } else colEnds[col] = p.effEnd;
    p.column = col;
    cluster.push(p);
    clusterEnd = Math.max(cluster.length === 1 ? -Infinity : clusterEnd, p.effEnd);
  }
  close();
  return placed;
}

export function layoutDay(events: LayoutEvent[], options: LayoutOptions = {}): DayLayout {
  const dayMinutes = options.dayMinutes ?? DEFAULTS.dayMinutes;
  const threshold = options.threshold ?? DEFAULTS.threshold;
  const scale = options.scale ?? DEFAULTS.scale;
  const minH = options.minEventHeight ?? DEFAULTS.minEventHeight;
  const squeezedH = options.squeezedHeight ?? DEFAULTS.squeezedHeight;
  const expanded = options.expanded ?? new Set<number>();

  const placed = assignColumns(events, dayMinutes);

  // Cut the day at every start and end; each piece is busy or free.
  const cuts = new Set<number>([0, dayMinutes]);
  for (const p of placed) {
    cuts.add(p.start);
    cuts.add(p.effEnd);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const segs = points.slice(0, -1).map((a, i) => ({ start: a, end: points[i + 1], busy: false, height: 0, squeezed: false }));
  const segIndex = new Map(points.map((p, i) => [p, i]));

  // Mark busy pieces with a difference array over segment indexes.
  const diff = new Array(segs.length + 1).fill(0);
  for (const p of placed) {
    diff[segIndex.get(p.start)!]++;
    diff[segIndex.get(p.effEnd)!]--;
  }
  let running = 0;
  for (let i = 0; i < segs.length; i++) {
    running += diff[i];
    segs[i].busy = running > 0;
  }

  for (const s of segs) {
    const len = s.end - s.start;
    if (!s.busy && len > threshold && !expanded.has(s.start)) {
      s.squeezed = true;
      s.height = squeezedH;
    } else s.height = len * scale;
  }

  // Give every appointment room to read; stretch its last piece if needed.
  for (const p of placed) {
    const a = segIndex.get(p.start)!;
    const b = segIndex.get(p.effEnd)!;
    let h = 0;
    for (let i = a; i < b; i++) h += segs[i].height;
    if (h < minH) segs[b - 1].height += minH - h;
  }

  const tops: number[] = [];
  let y = 0;
  for (const s of segs) {
    tops.push(y);
    y += s.height;
  }
  tops.push(y);

  const blocks: Block[] = [];
  const wholeDayFree = placed.length === 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.busy || s.end <= s.start) continue;
    if (s.squeezed) {
      blocks.push({
        kind: "squeezed",
        start: s.start,
        end: s.end,
        top: tops[i],
        height: s.height,
        label: freeLabel(s.end - s.start, wholeDayFree),
      });
    } else {
      blocks.push({ kind: "gap", start: s.start, end: s.end, top: tops[i], height: s.height, expanded: expanded.has(s.start) && s.end - s.start > threshold });
    }
  }
  for (const p of placed) {
    const a = segIndex.get(p.start)!;
    const b = segIndex.get(p.effEnd)!;
    blocks.push({
      kind: "event",
      id: p.id,
      start: p.start,
      end: p.end,
      top: tops[a],
      height: tops[b] - tops[a],
      column: p.column,
      columns: p.columns,
    });
  }
  blocks.sort((x, z) => x.top - z.top || x.start - z.start || (x.kind === "event" && z.kind === "event" ? x.column - z.column : 0));
  const axis = segs.map((s, i) => ({ start: s.start, end: s.end, top: tops[i], height: s.height, squeezed: s.squeezed }));
  return { height: y, blocks, axis };
}

/**
 * Where a minute of the day sits on the page (for hour marks), or null when it
 * falls inside a squeezed strip.
 */
export function positionOf(layout: DayLayout, minute: number): number | null {
  for (const e of layout.axis) {
    if (minute >= e.start && minute < e.end) {
      if (e.squeezed) return null;
      return e.top + ((minute - e.start) / (e.end - e.start)) * e.height;
    }
  }
  return null;
}
