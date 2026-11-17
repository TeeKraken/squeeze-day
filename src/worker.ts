/// <reference lib="webworker" />
/**
 * Holds calendars off the main thread, so reading a big file or working out
 * repeating events never freezes the page. A newly read calendar is kept as a
 * candidate until the page activates it, so the calendar shown and the one
 * answering day requests are always the same one.
 */
import { Calendar, CalendarError } from "./logic/calendar";
import type { WorkerRequest, WorkerResponse } from "./protocol";

const candidates = new Map<number, Calendar>();
let active: { loadId: number; calendar: Calendar } | null = null;

function reply(msg: WorkerResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "parse") {
      const calendar = new Calendar(msg.texts);
      candidates.set(msg.loadId, calendar);
      reply({ type: "parsed", id: msg.id, summary: calendar.summary });
    } else if (msg.type === "activate") {
      const calendar = candidates.get(msg.loadId);
      if (!calendar) throw new CalendarError("That calendar is no longer available. Try adding it again.");
      active = { loadId: msg.loadId, calendar };
      candidates.clear();
      reply({ type: "activated", id: msg.id });
    } else if (msg.type === "discard") {
      candidates.delete(msg.loadId);
      reply({ type: "done", id: msg.id });
    } else if (msg.type === "day") {
      if (!active) throw new CalendarError("No calendar is open.");
      reply({ type: "day", id: msg.id, loadId: active.loadId, day: active.calendar.day(msg.day) });
    } else if (msg.type === "clear") {
      active = null;
      candidates.clear();
      reply({ type: "done", id: msg.id });
    }
  } catch (err) {
    reply({
      type: "error",
      id: msg.id,
      message:
        err instanceof CalendarError
          ? err.message
          : "Something went wrong reading this calendar. Try exporting it again; if it keeps happening, please tell us (see the link at the bottom).",
    });
  }
};
