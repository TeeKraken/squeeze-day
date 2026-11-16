/// <reference lib="webworker" />
/**
 * Holds the parsed calendar off the main thread, so reading a big file or
 * working out repeating events never freezes the page.
 */
import { Calendar, CalendarError } from "./logic/calendar";
import type { WorkerRequest, WorkerResponse } from "./protocol";

let calendar: Calendar | null = null;

function reply(msg: WorkerResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      // Only replace the current calendar once the new one has been read.
      const next = new Calendar(msg.texts);
      calendar = next;
      reply({ type: "loaded", id: msg.id, summary: next.summary });
    } else if (msg.type === "day") {
      if (!calendar) throw new CalendarError("No calendar is loaded.");
      reply({ type: "day", id: msg.id, day: calendar.day(msg.day) });
    } else if (msg.type === "clear") {
      calendar = null;
      reply({ type: "cleared", id: msg.id });
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
