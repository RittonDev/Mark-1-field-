// Datas e layout do calendário (no fuso do navegador, que é o da operação).

import type { CalendarEvent, TicketStatus } from "./types";

export type CalendarView = "month" | "week" | "day";

export const DAY_MS = 86_400_000;

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/** Semana começando no domingo, como no calendário brasileiro. */
export function startOfWeek(d: Date): Date {
  return addDays(startOfDay(d), -d.getDay());
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Período exibido por cada visão (o mês ocupa 6 semanas inteiras). */
export function visibleRange(view: CalendarView, anchor: Date): { start: Date; end: Date; days: Date[] } {
  let start: Date;
  let count: number;
  if (view === "month") {
    start = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    count = 42;
  } else if (view === "week") {
    start = startOfWeek(anchor);
    count = 7;
  } else {
    start = startOfDay(anchor);
    count = 1;
  }
  const days = Array.from({ length: count }, (_, i) => addDays(start, i));
  return { start, end: addDays(start, count), days };
}

export function shiftAnchor(view: CalendarView, anchor: Date, step: -1 | 1): Date {
  if (view === "month") return new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
  return addDays(anchor, view === "week" ? 7 * step : step);
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pt-BR", opts);
const MONTH_YEAR = fmt({ month: "long", year: "numeric" });
const DAY_MONTH = fmt({ day: "2-digit", month: "short" });
const LONG_DAY = fmt({ weekday: "long", day: "2-digit", month: "long", year: "numeric" });

export function rangeTitle(view: CalendarView, anchor: Date): string {
  if (view === "month") return MONTH_YEAR.format(anchor);
  if (view === "day") return LONG_DAY.format(anchor);
  const start = startOfWeek(anchor);
  const end = addDays(start, 6);
  return `${DAY_MONTH.format(start)} – ${DAY_MONTH.format(end)} de ${end.getFullYear()}`;
}

export const WEEKDAYS_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Cor fixa por técnico (pela ordem da lista), para reconhecer cada um no calendário.
const PALETTE = ["#2447ff", "#0891b2", "#059669", "#d97706", "#7c3aed", "#db2777", "#0d9488", "#ea580c", "#4f46e5", "#65a30d"];
export const UNASSIGNED_COLOR = "#98a2b3";

export function colorMap(ids: string[]): Map<string, string> {
  return new Map(ids.map((id, i) => [id, PALETTE[i % PALETTE.length]]));
}

// OS que ainda ocupam a agenda (espelha OCCUPYING em backend/app/services/schedule.py).
export const ACTIVE_STATUSES: TicketStatus[] = [
  "new",
  "triage",
  "assigned",
  "scheduled",
  "en_route",
  "in_progress",
  "on_hold_customer",
  "on_hold_vendor",
  "reopened",
];

export interface Placed {
  event: CalendarEvent;
  start: Date;
  end: Date;
  lane: number;
  lanes: number;
}

/**
 * Recorta as OS ao dia e distribui as sobrepostas lado a lado
 * (mesmo técnico lado a lado = conflito, que já vem marcado da API).
 */
export function layoutDay(events: CalendarEvent[], day: Date): Placed[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + DAY_MS;
  const items = events
    .map((event) => {
      const s = Math.max(new Date(event.start).getTime(), dayStart);
      const e = Math.min(new Date(event.end).getTime(), dayEnd);
      return { event, s, e };
    })
    .filter((x) => x.e > x.s)
    .sort((a, b) => a.s - b.s || b.e - a.e);

  const placed: Placed[] = [];
  let cluster: Placed[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    cluster.forEach((p) => (p.lanes = laneEnds.length));
    cluster = [];
    laneEnds = [];
  };
  for (const { event, s, e } of items) {
    if (s >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= s);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(e);
    } else {
      laneEnds[lane] = e;
    }
    clusterEnd = Math.max(clusterEnd, e);
    const p: Placed = { event, start: new Date(s), end: new Date(e), lane, lanes: 1 };
    cluster.push(p);
    placed.push(p);
  }
  flush();
  return placed;
}

export function eventsOnDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + DAY_MS;
  return events.filter((e) => new Date(e.start).getTime() < dayEnd && new Date(e.end).getTime() > dayStart);
}
