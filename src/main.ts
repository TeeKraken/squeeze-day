import "./style.css";
import type { AllDayItem, CalendarSummary, DayEvent, DayEvents } from "./logic/calendar";
import { dayNumber, dayRange, localDayNumber } from "./logic/time";
import { isZip, readIcsFromZip, ZipError } from "./logic/zip";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { loadSaved, loadThreshold, removeSaved, save, saveThreshold } from "./store";
import { LoadPipeline, type CalendarFile, type Kept } from "./pipeline";
import { dayDate, drawAllDay, drawTimeline, formatDay, formatShortDay, timeRange, type DrawOptions } from "./view";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const start = $("start");
const dayview = $("dayview");
const settings = $("settings");
const fileInput = $<HTMLInputElement>("file");
const fileInput2 = $<HTMLInputElement>("file2");
const sampleBtn = $<HTMLButtonElement>("sample-btn");
const sampleNote = $("sample-note");
const sampleOwn = $<HTMLButtonElement>("sample-own");
const status1 = $("load-status");
const error1 = $("load-error");
const status2 = $("load-status2");
const error2 = $("load-error2");
const dayTitle = $("day-title");
const daySub = $("day-sub");
const prevBtn = $<HTMLButtonElement>("prev");
const nextBtn = $<HTMLButtonElement>("next");
const todayBtn = $<HTMLButtonElement>("today");
const gotoInput = $<HTMLInputElement>("goto");
const alldayWrap = $("allday");
const alldayList = $("allday-list");
const timeline = $("timeline");
const thresholdSelect = $<HTMLSelectElement>("threshold");
const calInfo = $("cal-info");
const calKeep = $("cal-keep");
const calWarn = $("cal-warn");
const dayWarn = $("day-warn");
const removeBtn = $<HTMLButtonElement>("remove");
const dialog = $<HTMLDialogElement>("details");
const detailsTitle = $("details-title");
const detailsWhen = $("details-when");
const detailsWhere = $("details-where");
const detailsClose = $<HTMLButtonElement>("details-close");

/** The made-up sample opens on a day that shows everything off. */
const SAMPLE_DAY = dayNumber(2026, 11, 17);
const MAX_BYTES = 100 * 1024 * 1024;

type Mode = "none" | "sample" | "mine";

const state = {
  mode: "none" as Mode,
  day: localDayNumber(new Date()),
  threshold: 60,
  expanded: new Set<number>(),
  data: null as DayEvents | null,
  summary: null as CalendarSummary | null,
  names: [] as string[],
  /** What happened when keeping the calendar on this device. */
  kept: "yes" as Kept,
  /** Which load the shown calendar came from; day answers from any other are ignored. */
  loadId: 0,
};

/** Whether a calendar is currently kept in this browser's storage. */
let savedNow = false;

// ---- the worker that holds the calendar ----

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let nextId = 1;
const pending = new Map<number, (r: WorkerResponse) => void>();
worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const done = pending.get(e.data.id);
  pending.delete(e.data.id);
  done?.(e.data);
};
type Req = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;
function ask(msg: Req): Promise<WorkerResponse> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ ...msg, id } as WorkerRequest);
  });
}

// ---- reading files ----

class FileProblem extends Error {}

async function readFiles(files: File[]): Promise<CalendarFile[]> {
  const out: CalendarFile[] = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) throw new FileProblem(`"${file.name}" is too big to open here (over 100 MB).`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isZip(bytes)) {
      out.push(...(await readIcsFromZip(bytes)));
      continue;
    }
    const text = new TextDecoder().decode(bytes);
    if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096))) {
      throw new FileProblem(`"${file.name}" doesn't look like a calendar file. Choose a file ending in .ics (or the .zip Google Calendar gives you).`);
    }
    out.push({ name: file.name, text });
  }
  return out;
}

function setStatus(msg: string, err = ""): void {
  for (const el of [status1, status2]) el.textContent = msg;
  for (const el of [error1, error2]) el.textContent = err;
}

const pipeline = new LoadPipeline<CalendarSummary>({
  async parse(loadId, files) {
    const res = await ask({ type: "parse", loadId, texts: files.map((f) => f.text) });
    if (res.type === "parsed") return { ok: true, summary: res.summary };
    return { ok: false, message: res.type === "error" ? res.message : "Something went wrong." };
  },
  discard(loadId) {
    void ask({ type: "discard", loadId });
  },
  async activate(loadId) {
    const res = await ask({ type: "activate", loadId });
    if (res.type !== "activated") throw new Error(res.type === "error" ? res.message : "activate failed");
  },
  save: (files) => save({ files, savedAt: Date.now() }),
  removeSaved,
});

class NothingSaved extends Error {}

/**
 * Loads a calendar through the pipeline and, if it's still wanted when it's
 * ready, shows it. Errors leave the current calendar as it was.
 */
async function runLoad(read: () => Promise<CalendarFile[]>, mode: Mode, day: () => number, keep: boolean): Promise<void> {
  const g = pipeline.current;
  const wasStart = !start.hidden;
  setStatus(mode === "sample" ? "Opening the sample…" : "Reading your calendar…");
  let r;
  try {
    r = await pipeline.load(read, keep, () => savedNow);
  } catch (err) {
    if (g !== pipeline.current || err instanceof NothingSaved) return setStatus("");
    setStatus(
      "",
      err instanceof FileProblem || err instanceof ZipError
        ? err.message
        : mode === "sample"
          ? "The sample couldn't be loaded. Check your connection and try again."
          : "That file couldn't be opened. Try choosing it again.",
    );
    return;
  }
  if (g !== pipeline.current || r.status === "cancelled") return;
  if (r.status === "error") {
    setStatus("", r.message);
    return;
  }
  if (r.kept === "yes") savedNow = true;
  else if (r.kept === "no") savedNow = false;
  state.loadId = r.loadId;
  state.mode = mode;
  state.summary = r.summary;
  state.names = r.files.map((f) => f.name);
  if (mode === "mine") state.kept = r.kept === "not-asked" ? "yes" : r.kept;
  setStatus("");
  showDayview();
  await goTo(day());
  // The button that started this is now hidden: put focus somewhere useful.
  if (wasStart && g === pipeline.current) dayTitle.focus();
}

function onFiles(input: HTMLInputElement): void {
  const files = input.files ? Array.from(input.files) : [];
  input.value = "";
  if (files.length === 0) return;
  void runLoad(() => readFiles(files), "mine", () => localDayNumber(new Date()), true);
}

// ---- showing a day ----

function showDayview(): void {
  start.hidden = true;
  dayview.hidden = false;
  settings.hidden = false;
  sampleNote.hidden = state.mode !== "sample";
  const s = state.summary!;
  const what = state.mode === "sample" ? "The sample calendar" : state.names.length === 1 ? `"${state.names[0]}"` : `${state.names.length} calendars`;
  calInfo.textContent = `${what}: ${s.events.toLocaleString()} ${s.events === 1 ? "event" : "events"}${s.recurring ? ` (${s.recurring.toLocaleString()} repeating)` : ""}.`;
  calWarn.textContent = s.unreadable
    ? `${s.unreadable.toLocaleString()} ${s.unreadable === 1 ? "event" : "events"} in this file couldn't be read, so ${s.unreadable === 1 ? "it isn't" : "they aren't"} shown. Check them in your calendar app.`
    : "";
  if (state.mode === "sample") calKeep.textContent = "The sample isn't kept. Add your own calendar to keep it on this device.";
  else if (state.kept === "yes") calKeep.textContent = "Your calendar stays on this device, so it's here when you come back. It's a copy: add a newer copy to see later changes.";
  else if (state.kept === "old-copy-remains")
    calKeep.textContent = "This browser wouldn't save this newer copy, and couldn't clear the older one. Next time the older copy will open instead. Use \"Remove this calendar\" to clear it.";
  else calKeep.textContent = "This browser wouldn't let the app keep your calendar, so you'll need to add it again next time. Nothing was uploaded.";
  removeBtn.textContent = state.mode === "sample" ? "Close the sample" : "Remove this calendar";
}

let dayTicket = 0;
async function goTo(day: number, focusTitle = false): Promise<void> {
  const ticket = ++dayTicket;
  if (day !== state.day) state.expanded.clear();
  state.day = day;
  dayTitle.textContent = formatDay(day);
  daySub.textContent = "";
  const today = localDayNumber(new Date());
  todayBtn.disabled = day === today;
  const d = dayDate(day);
  gotoInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  try {
    history.replaceState(null, "", `#${gotoInput.value}`);
  } catch {
    /* not important */
  }
  const res = await ask({ type: "day", day });
  if (ticket !== dayTicket || state.mode === "none") return;
  // Only ever draw days from the calendar this page is showing.
  if (res.type === "day" && res.loadId !== state.loadId) return;
  if (res.type !== "day") {
    setStatus("", res.type === "error" ? res.message : "Something went wrong.");
    return;
  }
  state.data = res.day;
  draw();
  if (focusTitle) dayTitle.focus();
}

function draw(): void {
  const data = state.data;
  if (!data) return;
  const opts: DrawOptions = {
    threshold: state.threshold,
    expanded: state.expanded,
    onOpenGap: (s) => {
      state.expanded.add(s);
      draw();
      focusBlock(`[data-gap="${s}"] .squeeze-btn`);
    },
    onCloseGap: (s) => {
      state.expanded.delete(s);
      draw();
      focusBlock(`[data-fold="${s}"] .fold-btn`);
    },
    onEvent: showDetails,
  };
  // Redrawing replaces whatever was focused inside the day; keep focus on the page.
  const active = document.activeElement;
  const focusWasInDay = !!active && (timeline.contains(active) || alldayList.contains(active));
  drawAllDay(alldayList, alldayWrap, data, opts);
  drawTimeline(timeline, data, opts);
  if (focusWasInDay) dayTitle.focus();
  dayWarn.textContent = data.failedSeries
    ? `${data.failedSeries === 1 ? "A repeating event" : `${data.failedSeries} repeating events`} couldn't be worked out, so this day may be missing ${data.failedSeries === 1 ? "it" : "them"}.`
    : "";
  const n = data.timed.length;
  const a = data.allDay.length;
  const parts: string[] = [];
  if (n) parts.push(`${n} ${n === 1 ? "appointment" : "appointments"}`);
  if (a) parts.push(`${a} all day`);
  daySub.textContent = parts.length ? parts.join(" · ") : "Nothing on this day";
}

function focusBlock(selector: string): void {
  const el = timeline.querySelector<HTMLElement>(selector);
  el?.focus();
}

function showDetails(ev: DayEvent | AllDayItem): void {
  detailsTitle.textContent = ev.title;
  const { start: ds, end: de } = dayRange(state.day);
  if ("start" in ev) {
    detailsWhen.textContent = `${formatShortDay(state.day)}, ${timeRange(ev, ds, de)}`;
  } else if (ev.timed) {
    detailsWhen.textContent = `${timeRange(ev.timed, Infinity, -Infinity).replace(/^From /, "")}`;
  } else if (ev.lastDay > ev.firstDay) {
    detailsWhen.textContent = `All day, ${formatShortDay(ev.firstDay)} to ${formatShortDay(ev.lastDay)}`;
  } else {
    detailsWhen.textContent = `All day, ${formatShortDay(ev.firstDay)}`;
  }
  detailsWhere.textContent = ev.location ? `Where: ${ev.location}` : "";
  detailsWhere.hidden = !ev.location;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

detailsClose.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});

// ---- controls ----

fileInput.addEventListener("change", () => onFiles(fileInput));
fileInput2.addEventListener("change", () => onFiles(fileInput2));

sampleBtn.addEventListener("click", () => {
  void runLoad(
    async () => {
      const res = await fetch("/sample-calendar.ics");
      if (!res.ok) throw new Error(String(res.status));
      return [{ name: "sample-calendar.ics", text: await res.text() }];
    },
    "sample",
    () => SAMPLE_DAY,
    false,
  );
});

/**
 * Goes back to the start page. Loads still in progress are cancelled at once;
 * `clearStorage` also clears the saved calendar (after any save under way).
 */
function backToStart(clearStorage: boolean): Promise<boolean | null> {
  const removal = pipeline.remove(clearStorage);
  void ask({ type: "clear" });
  state.mode = "none";
  state.loadId = 0;
  state.data = null;
  state.summary = null;
  dayview.hidden = true;
  settings.hidden = true;
  start.hidden = false;
  setStatus("");
  try {
    history.replaceState(null, "", location.pathname);
  } catch {
    /* not important */
  }
  $("start-title").focus();
  return removal;
}

sampleOwn.addEventListener("click", () => {
  void backToStart(false);
  fileInput.focus();
});

removeBtn.addEventListener("click", async () => {
  const wasMine = state.mode === "mine";
  const g = pipeline.current + 1;
  const ok = await backToStart(wasMine);
  if (ok === null) return;
  if (ok) savedNow = false;
  if (g !== pipeline.current || !wasMine) return;
  setStatus(ok ? "Your calendar was removed from this device." : "", ok ? "" : "The app couldn't clear its storage. Clear this site's data in your browser settings to be sure.");
});

prevBtn.addEventListener("click", () => void goTo(state.day - 1));
nextBtn.addEventListener("click", () => void goTo(state.day + 1));
todayBtn.addEventListener("click", () => void goTo(localDayNumber(new Date()), true));
gotoInput.addEventListener("change", () => {
  const m = gotoInput.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) void goTo(dayNumber(Number(m[1]), Number(m[2]), Number(m[3])));
});

thresholdSelect.addEventListener("change", () => {
  const v = thresholdSelect.value;
  state.threshold = v === "never" ? Infinity : Number(v);
  state.expanded.clear();
  saveThreshold(v);
  draw();
});

document.addEventListener("keydown", (e) => {
  if (dayview.hidden || dialog.open || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target as HTMLElement;
  if (t.closest("input, select, textarea")) return;
  if (e.key === "ArrowLeft") void goTo(state.day - 1);
  else if (e.key === "ArrowRight") void goTo(state.day + 1);
  else return;
  e.preventDefault();
});

// Swipe left or right on the day to change days.
{
  const wrap = timeline.parentElement!;
  let sx = 0;
  let sy = 0;
  let tracking = false;
  wrap.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });
  wrap.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) void goTo(state.day + (dx < 0 ? 1 : -1));
  }, { passive: true });
}

// ---- start up ----

function dayFromHash(): number | null {
  const m = location.hash.match(/^#(\d{4})-(\d{2})-(\d{2})$/);
  return m ? dayNumber(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

(async () => {
  const t = loadThreshold();
  if (t && [...thresholdSelect.options].some((o) => o.value === t)) {
    thresholdSelect.value = t;
    state.threshold = t === "never" ? Infinity : Number(t);
  }
  // Restoring goes through the same pipeline, so a sample or file chosen meanwhile simply follows it.
  await runLoad(
    async () => {
      const saved = await loadSaved();
      if (!saved || !saved.files.length) throw new NothingSaved();
      savedNow = true;
      return saved.files;
    },
    "mine",
    () => dayFromHash() ?? localDayNumber(new Date()),
    false,
  );
})();
