import type { CalendarSummary, DayEvents } from "./logic/calendar";

export type WorkerRequest =
  | { type: "load"; id: number; texts: string[] }
  | { type: "day"; id: number; day: number }
  | { type: "clear"; id: number };

export type WorkerResponse =
  | { type: "loaded"; id: number; summary: CalendarSummary }
  | { type: "day"; id: number; day: DayEvents }
  | { type: "cleared"; id: number }
  | { type: "error"; id: number; message: string };
