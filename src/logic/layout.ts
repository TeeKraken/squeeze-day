/**
 * The squeezed day layout: a pure function from one day's appointments to
 * positioned blocks.
 *
 * Time runs down the page. Busy time and short free gaps are drawn to scale,
 * so "back to back" and "five minutes apart" look different. Free stretches
 * longer than the threshold fold into a thin strip labelled with their length.
 * Every appointment gets at least `minEventHeight` (side-by-side ones
 * `minSideHeight`) so its time and title stay readable; when one needs more
 * room, the time axis stretches there, so nothing ever covers the block after
 * it. Overlapping appointments sit side by side in columns.
 *
 * Time taken by an event shown in the all-day row (a timed event that covers
 * the whole day, like a trip) is "covered": never called free, and folded
 * into a strip named after that event when long.
 */

export interface LayoutEvent {
  id: string;
  /** Minutes from the start of the day (may be fractional). */
  start: number;
  end: number;
}

export interface Covered {
  start: number;
  end: number;
  /** What's taking the time, e.g. "Conference". */
  title: string;
}

export interface LayoutOptions {
  /** Minutes in this day: 1440, or 1380 / 1500 on clock-change days. */
  dayMinutes?: number;
  /** Free stretches longer than this many minutes are squeezed. Infinity = never. */
  threshold?: number;
  /** Pixels per minute for things drawn to scale. */
  scale?: number;
  minEventHeight?: number;
  /** Minimum height for appointments sharing the width with others (they need more lines). */
  minSideHeight?: number;
  squeezedHeight?: number;
  /** Start minutes of squeezed gaps the person has opened back to full size. */
  expanded?: ReadonlySet<number>;
  covered?: Covered[];
}

export type Block =
  | { kind: "event"; id: string; start: number; end: number; top: number; height: number; column: number; columns: number }
  | { kind: "gap"; start: number; end: number; top: number; height: number; expanded: boolean; covered?: string }
  | { kind: "squeezed"; start: number; end: number; top: number; height: number; label: string; covered?: string };

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

/** "45 min", "3 h", "2 h 30". */
export function lengthLabel(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${String(rest).padStart(2, "0")}`;
}

/** "45 min free", "3 h free", "2 h 30 free". */
export function freeLabel(minutes: number, wholeDay = false): string {
  return wholeDay ? "Free all day" : `${lengthLabel(minutes)} free`;
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

interface Piece {
  start: number;
  end: number;
  busy: boolean;
  covered: string[];
  height: number;
  squeezed: boolean;
}

export function layoutDay(events: LayoutEvent[], options: LayoutOptions = {}): DayLayout {
  const dayMinutes = options.dayMinutes ?? DEFAULTS.dayMinutes;
  const threshold = options.threshold ?? DEFAULTS.threshold;
  const scale = options.scale ?? DEFAULTS.scale;
  const minH = options.minEventHeight ?? DEFAULTS.minEventHeight;
  const minSide = options.minSideHeight ?? minH;
  const squeezedH = options.squeezedHeight ?? DEFAULTS.squeezedHeight;
  const expanded = options.expanded ?? new Set<number>();
  const covered = (options.covered ?? [])
    .map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(dayMinutes, c.end) }))
    .filter((c) => c.end > c.start);

  const placed = assignColumns(events, dayMinutes);

  // Cut the day at every start and end; each piece is busy, covered or free.
  const cuts = new Set<number>([0, dayMinutes]);
  for (const p of placed) {
    cuts.add(p.start);
    cuts.add(p.effEnd);
  }
  for (const c of covered) {
    cuts.add(c.start);
    cuts.add(c.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const raw: Piece[] = points.slice(0, -1).map((a, i) => ({ start: a, end: points[i + 1], busy: false, covered: [], height: 0, squeezed: false }));
  const rawIndex = new Map(points.map((p, i) => [p, i]));

  // Mark busy pieces with a difference array over piece indexes.
  const diff = new Array(raw.length + 1).fill(0);
  for (const p of placed) {
    diff[rawIndex.get(p.start)!]++;
    diff[rawIndex.get(p.effEnd)!]--;
  }
  let running = 0;
  for (let i = 0; i < raw.length; i++) {
    running += diff[i];
    raw[i].busy = running > 0;
  }
  for (const c of covered) {
    for (let i = rawIndex.get(c.start)!; i < rawIndex.get(c.end)!; i++) {
      if (!raw[i].covered.includes(c.title)) raw[i].covered.push(c.title);
    }
  }

  // Join neighbouring free (or identically covered) pieces, so one stretch is one strip.
  const pieces: Piece[] = [];
  for (const s of raw) {
    const prev = pieces[pieces.length - 1];
    if (prev && !prev.busy && !s.busy && prev.covered.join("\n") === s.covered.join("\n")) prev.end = s.end;
    else pieces.push({ ...s });
  }
  // Event edges always border a busy piece, so they survive the joining.
  const index = new Map<number, number>();
  pieces.forEach((s, i) => index.set(s.start, i));
  index.set(dayMinutes, pieces.length);

  for (const s of pieces) {
    const len = s.end - s.start;
    if (!s.busy && len > threshold && !expanded.has(s.start)) {
      s.squeezed = true;
      s.height = squeezedH;
    } else s.height = len * scale;
  }

  // Give every appointment room to read; stretch its last piece if needed.
  for (const p of placed) {
    const a = index.get(p.start)!;
    const b = index.get(p.effEnd)!;
    let h = 0;
    for (let i = a; i < b; i++) h += pieces[i].height;
    const need = p.columns > 1 ? minSide : minH;
    if (h < need) pieces[b - 1].height += need - h;
  }

  const tops: number[] = [];
  let y = 0;
  for (const s of pieces) {
    tops.push(y);
    y += s.height;
  }
  tops.push(y);

  const blocks: Block[] = [];
  const wholeDayFree = placed.length === 0 && covered.length === 0;
  for (let i = 0; i < pieces.length; i++) {
    const s = pieces[i];
    if (s.busy || s.end <= s.start) continue;
    const coveredBy = s.covered.length ? s.covered.join(", ") : undefined;
    const extra = coveredBy ? { covered: coveredBy } : {};
    if (s.squeezed) {
      const whole = s.start === 0 && s.end === dayMinutes;
      const label = coveredBy ? `${whole ? "All day" : lengthLabel(s.end - s.start)} · ${coveredBy}` : freeLabel(s.end - s.start, wholeDayFree);
      blocks.push({ kind: "squeezed", start: s.start, end: s.end, top: tops[i], height: s.height, label, ...extra });
    } else {
      blocks.push({ kind: "gap", start: s.start, end: s.end, top: tops[i], height: s.height, expanded: expanded.has(s.start) && s.end - s.start > threshold, ...extra });
    }
  }
  for (const p of placed) {
    const a = index.get(p.start)!;
    const b = index.get(p.effEnd)!;
    blocks.push({ kind: "event", id: p.id, start: p.start, end: p.end, top: tops[a], height: tops[b] - tops[a], column: p.column, columns: p.columns });
  }
  blocks.sort((x, z) => x.top - z.top || x.start - z.start || (x.kind === "event" && z.kind === "event" ? x.column - z.column : 0));
  const axis = pieces.map((s, i) => ({ start: s.start, end: s.end, top: tops[i], height: s.height, squeezed: s.squeezed }));
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
