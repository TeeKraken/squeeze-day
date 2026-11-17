import type { CalendarSummary, DayEvents } from "./logic/calendar";

export type WorkerRequest =
  /** Parse files into a candidate held under loadId (not shown yet). */
  | { type: "parse"; id: number; loadId: number; texts: string[] }
  /** Make that candidate the calendar days are read from. */
  | { type: "activate"; id: number; loadId: number }
  | { type: "discard"; id: number; loadId: number }
  | { type: "day"; id: number; day: number }
  | { type: "clear"; id: number };

export type WorkerResponse =
  | { type: "parsed"; id: number; summary: CalendarSummary }
  | { type: "activated"; id: number }
  /** A day from the active calendar, with which load it came from. */
  | { type: "day"; id: number; loadId: number; day: DayEvents }
  | { type: "done"; id: number }
  | { type: "error"; id: number; message: string };
