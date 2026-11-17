// Limites e formatos que os cartões da Início dividem (fonte única: dois números da tela nunca seguem
// regras diferentes). Percentual só com base suficiente; abaixo disso, "N de M".

import type { AgeKey, Ratio } from "./types";

/** Base mínima para mostrar % (abaixo disso: só "N de M" e "Poucos dados"). */
export const MIN_BASE = 20;
/** Base mínima de uma linha (um cliente) para mostrar %. */
export const MIN_BASE_ROW = 10;
/** Meta do prazo de solução (%), a mesma do /dashboard: abaixo dela, âmbar. */
export const SLA_TARGET = 90;
/** Piso do prazo de solução (%): abaixo dele, vermelho. */
export const SLA_FLOOR = 75;
/** Cliente com chegada no horário este tanto (pontos percentuais) abaixo da operação fica em âmbar. */
export const CUSTOMER_GAP = 10;

/** Folga do saldo da fila: até este tanto (para mais ou para menos), a fila está estável. */
export function growthLimit(entered: number): number {
  return Math.max(5, Math.round(entered * 0.05));
}

export const intFmt = (n: number) => n.toLocaleString("pt-BR");

/** "1 técnico", "3 técnicos", "1.006 OS". */
export function plural(n: number, one: string, many: string): string {
  return `${intFmt(n)} ${n === 1 ? one : many}`;
}

/**
 * "79%" de 10 para cima; "2,7%" abaixo. Não arredonda para 0% ou 100% o que não é (99,6% sai 99%;
 * 0,04% sai 0,1%).
 */
export function pctText(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n <= 0) return "0%";
  if (n >= 100) return "100%";
  const one = Math.round(n * 10) / 10;
  if (one >= 10) return `${Math.min(99, Math.round(n))}%`;
  return `${Math.max(0.1, one).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

/** "170 de 215" e o % só com base de `min` ou mais. */
export function share(r: Ratio, min: number): { pct: number | null; text: string } {
  return {
    pct: r.base > 0 && r.base >= min ? (100 * r.count) / r.base : null,
    text: `${intFmt(r.count)} de ${intFmt(r.base)}`,
  };
}

/** Cor do medidor: o acento; âmbar abaixo da meta; vermelho abaixo do piso. */
export type MeterTone = "accent" | "warning" | "danger";

export function meterTone(pct: number, target?: number, floor?: number): MeterTone {
  if (floor !== undefined && pct < floor) return "danger";
  if (target !== undefined && pct < target) return "warning";
  return "accent";
}

/** Faixas de idade da fila em aberto. */
export const AGE_LABEL: Record<AgeKey, string> = {
  d7: "Até 7 dias",
  d30: "8 a 30 dias",
  d90: "31 a 90 dias",
  older: "Mais de 90 dias",
};

/** "+23", "−4", "0" (com o sinal de menos tipográfico). */
export function signed(n: number): string {
  if (n > 0) return `+${intFmt(n)}`;
  if (n < 0) return `−${intFmt(-n)}`;
  return "0";
}

/** "1h18", "2h", "45 min". */
export function hoursText(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

// Dias "AAAA-MM-DD" são de calendário: as contas vão em UTC, sem fuso no meio.

/** Dia vizinho ("2026-10-19", 29 -> "2026-11-17"). */
export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** "19/10". */
export function dayMonth(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match ? `${match[3]}/${match[2]}` : day;
}
