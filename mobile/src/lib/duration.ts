// Duração estimada × real da OS (backend/app/services/durations.py e o DurationCompare da web).
//
// O backend soma sozinho o tempo em "Em atendimento": grava `work_started_at` ao entrar
// e acumula em `work_seconds` ao sair. O `actual_minutes` da API vale para o instante da
// leitura; o app recalcula com o relógio do aparelho, então o contador anda mesmo offline.

import type { TicketDetail } from "./types";

/** A partir de quanto o real é considerado acima do estimado (UPPER_RATIO no backend). */
export const OVER_RATIO = 1.25;

type WorkClock = Pick<TicketDetail, "work_seconds" | "work_started_at">;

/** Tempo em atendimento, incluindo o trecho em andamento (durations.actual_seconds). */
export function actualSeconds(ticket: WorkClock, now: number): number {
  const running = ticket.work_started_at ? Math.floor((now - new Date(ticket.work_started_at).getTime()) / 1000) : 0;
  return (ticket.work_seconds ?? 0) + Math.max(running, 0);
}

export function actualMinutes(ticket: WorkClock, now: number): number {
  return Math.floor(actualSeconds(ticket, now) / 60);
}

export interface DurationSummary {
  estimated: number | null;
  actual: number;
  running: boolean;
  /** Real ÷ estimado, quando os dois existem. */
  ratio: number | null;
  over: boolean;
  /** "11,8× o estimado" ou "65% do estimado". */
  ratioText: string | null;
}

export function durationSummary(ticket: WorkClock & Pick<TicketDetail, "estimated_minutes">, now: number): DurationSummary {
  const estimated = ticket.estimated_minutes ?? null;
  const actual = actualMinutes(ticket, now);
  const ratio = estimated && actual > 0 ? actual / estimated : null;
  return {
    estimated,
    actual,
    running: Boolean(ticket.work_started_at),
    ratio,
    over: ratio !== null && ratio >= OVER_RATIO,
    ratioText:
      ratio === null
        ? null
        : ratio >= 1
          ? `${ratio.toFixed(1).replace(".", ",")}× o estimado`
          : `${Math.round(ratio * 100)}% do estimado`,
  };
}

/** Fim da visita quando só o início é informado: início + duração estimada (tickets.py::_default_end). */
export function defaultEnd(start: string, end: string | null | undefined, estimatedMinutes: number | null | undefined) {
  if (end) return end;
  if (!estimatedMinutes) return null;
  return new Date(new Date(start).getTime() + estimatedMinutes * 60_000).toISOString();
}
