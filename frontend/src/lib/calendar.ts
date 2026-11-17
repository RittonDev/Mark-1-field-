// Datas e layout do calendário no fuso da operação (horário de Brasília) em qualquer computador, como
// o resto do sistema (lib/format.ts): um analista em Manaus ou uma máquina virtual em UTC veem os
// mesmos dias e horas que a central.
//
// Por dentro, o relógio de parede da operação fica nos campos UTC de uma Date (getUTCHours,
// getUTCDate...): a conta de dias e horas da grade não depende do fuso nem do horário de verão do
// computador. `toWall` leva um instante para esse relógio e `fromWall` faz o caminho de volta (API).

import type { CalendarEvent, TicketStatus } from "./types";

export type CalendarView = "month" | "week" | "day";

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Fuso da operação (o mesmo de settings.TIMEZONE na API). */
export const OPERATION_TIMEZONE = "America/Sao_Paulo";

const offsetFmt = new Intl.DateTimeFormat("en-US", { timeZone: OPERATION_TIMEZONE, timeZoneName: "longOffset" });
// O deslocamento do fuso só muda na virada de uma hora: uma conta por hora basta (a grade lê centenas
// de horários a cada atualização).
const offsets = new Map<number, number>();

/** Deslocamento do fuso da operação naquele instante, em ms (ex.: -3 h). */
function offsetAt(ms: number): number {
  // Data malformada: sem deslocamento (vira "Invalid Date" adiante) em vez de derrubar a agenda inteira.
  if (!Number.isFinite(ms)) return 0;
  const hour = Math.floor(ms / HOUR_MS);
  let offset = offsets.get(hour);
  if (offset === undefined) {
    const name = offsetFmt.formatToParts(new Date(hour * HOUR_MS)).find((p) => p.type === "timeZoneName")?.value ?? "";
    const match = /([+-])(\d{2}):?(\d{2})?/.exec(name);
    const minutes = match ? Number(match[2]) * 60 + Number(match[3] ?? 0) : 0; // "GMT" puro: UTC
    offset = (match?.[1] === "-" ? -minutes : minutes) * 60_000;
    if (offsets.size > 20_000) offsets.clear();
    offsets.set(hour, offset);
  }
  return offset;
}

/** Instante (ISO, ms ou Date) no relógio de parede da operação. */
export function toWall(value: string | number | Date): Date {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : new Date(value).getTime();
  return new Date(ms + offsetAt(ms));
}

/** Do relógio da operação para o instante real (o que vai para a API). Duas passadas cobrem as datas
 *  antigas, do tempo do horário de verão. */
export function fromWall(wall: Date): Date {
  const ms = wall.getTime();
  return new Date(ms - offsetAt(ms - offsetAt(ms)));
}

export function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** Hoje (meia-noite) no fuso da operação. */
export function operationToday(now: number = Date.now()): Date {
  return startOfDay(toWall(now));
}

/** Início e fim do dia no relógio da operação. */
export function dayBounds(day: Date): [number, number] {
  const start = startOfDay(day).getTime();
  return [start, start + DAY_MS];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-13", para a URL. */
export function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Lê "2026-11-13" como um dia da operação; texto inválido devolve null. */
export function parseDayKey(value: string | null | undefined): Date | null {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(match[3]) ? null : d;
}

/** Semana começando no domingo, como no calendário brasileiro. */
export function startOfWeek(d: Date): Date {
  return addDays(startOfDay(d), -d.getUTCDay());
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

/** Período exibido por cada visão (o mês ocupa 6 semanas inteiras). */
export function visibleRange(view: CalendarView, anchor: Date): { start: Date; end: Date; days: Date[] } {
  let start: Date;
  let count: number;
  if (view === "month") {
    start = startOfWeek(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1)));
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
  if (view === "month") return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + step, 1));
  return addDays(anchor, view === "week" ? 7 * step : step);
}

/** Um dia da grade por escrito (ex.: { weekday: "long" } → "quinta-feira"). */
export function formatDay(day: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("pt-BR", { ...options, timeZone: "UTC" }).format(day);
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pt-BR", { ...opts, timeZone: "UTC" });
const MONTH_YEAR = fmt({ month: "long", year: "numeric" });
const DAY_MONTH = fmt({ day: "2-digit", month: "short" });
const LONG_DAY = fmt({ weekday: "long", day: "2-digit", month: "long", year: "numeric" });

export function rangeTitle(view: CalendarView, anchor: Date): string {
  if (view === "month") return MONTH_YEAR.format(anchor);
  if (view === "day") return LONG_DAY.format(anchor);
  const start = startOfWeek(anchor);
  const end = addDays(start, 6);
  return `${DAY_MONTH.format(start)} – ${DAY_MONTH.format(end)} de ${end.getUTCFullYear()}`;
}

export const WEEKDAYS_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "14:05" de uma hora do relógio da operação. */
export function hhmm(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Horas desde a meia-noite (ex.: 14,5 às 14:30), para posicionar na grade. */
export function hoursIntoDay(d: Date): number {
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

// Cor fixa por técnico, para reconhecer cada um no calendário.
const PALETTE = ["#2447ff", "#0891b2", "#059669", "#d97706", "#7c3aed", "#db2777", "#0d9488", "#ea580c", "#4f46e5", "#65a30d"];
export const UNASSIGNED_COLOR = "#98a2b3";

/**
 * Cor do técnico pelo id (FNV-1a): a mesma em qualquer tela e dia, e não muda quando alguém entra ou
 * sai da lista (pela posição na lista, ativar um técnico trocava a cor de todos depois dele).
 */
export function technicianColor(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return PALETTE[(hash >>> 0) % PALETTE.length];
}

export function colorMap(ids: string[]): Map<string, string> {
  return new Map(ids.map((id) => [id, technicianColor(id)]));
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

const spans = new WeakMap<CalendarEvent, [number, number]>();

/** Início e fim da OS no relógio da operação (ms), lidos uma vez por OS recebida. */
export function wallSpan(event: CalendarEvent): [number, number] {
  let span = spans.get(event);
  if (!span) {
    span = [toWall(event.start).getTime(), toWall(event.end).getTime()];
    spans.set(event, span);
  }
  return span;
}

export interface Placed {
  event: CalendarEvent;
  /** Início e fim já recortados ao dia, no relógio da operação. */
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
  const [dayStart, dayEnd] = dayBounds(day);
  const items = events
    .map((event) => {
      const [start, end] = wallSpan(event);
      return { event, s: Math.max(start, dayStart), e: Math.min(end, dayEnd) };
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
  const [dayStart, dayEnd] = dayBounds(day);
  return events.filter((e) => {
    const [start, end] = wallSpan(e);
    return start < dayEnd && end > dayStart;
  });
}
