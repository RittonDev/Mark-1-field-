// Indisponibilidade (Configurações › Dias e horários): os períodos de/até em que o técnico não atende, os dois dias
// inclusive e sem motivo (LGPD). As regras da folha do período são as do servidor (services/unavailability.py, que
// confere de novo; as mensagens daqui terminam com ponto); o corpo do PATCH /me/profile é a lista inteira dos que não
// terminaram, montada quando a gravação sai da fila (como a Formação); e o resumo da linha de Configurações. Puro (só
// ./constants): entra na sonda tests/unavailability.test.mjs.

import { availabilitySummary, periodShort, periodText, UNAVAILABILITY_LIMITS, unavailableOn } from "./constants";
import type { UnavailabilityIn, UnavailabilityPeriod } from "./types";

export { periodText };

/** A folha: "AAAA-MM-DD" ou vazio. */
export interface PeriodDraft {
  start: string | null;
  end: string | null;
}

export type PeriodField = "start" | "end";

/** A ordem da tela (o primeiro erro é o de cima). */
export const PERIOD_FIELDS: PeriodField[] = ["start", "end"];

export const PERIOD_MSG = {
  start: "Informe o início.",
  end: "Informe o fim.",
  order: "O fim não pode ser antes do início.",
  past: "O início não pode ser antes de hoje.",
  horizon: `Até ${UNAVAILABILITY_LIMITS.horizonDays} dias a partir de hoje.`,
  overlap: "Já há um período nessas datas.",
  limit: `Limite de ${UNAVAILABILITY_LIMITS.periods} períodos. Exclua um para incluir outro.`,
  /** Salvou a edição de um período que uma gravação anterior tirou da lista. */
  gone: "Este período não existe mais. Puxe a tela para atualizar.",
} as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** Hoje no fuso do aparelho, "AAAA-MM-DD" (o servidor aceita um dia de folga para o fuso). */
export function localDay(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** "AAAA-MM-DD" mais `days` dias (no calendário, sem horário de verão no meio). */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * Os limites do seletor "De": de hoje (editando um período que já começou, o início gravado) até 365 dias à frente. O
 * "Até" vai do "De" (ou de hoje, se o "De" já passou) ao mesmo fim.
 */
export function periodBounds(today: string, editing: UnavailabilityPeriod | null): { min: string; max: string } {
  const min = editing && editing.start < today ? editing.start : today;
  return { min, max: addDaysIso(today, UNAVAILABILITY_LIMITS.horizonDays) };
}

/**
 * Os erros da folha do período, na ordem da tela ({} quando pode salvar). `others`: os outros períodos (na edição, sem
 * o editado): nenhum dia em comum, os dois dias inclusive. O início antes de hoje só vale se for o gravado do período
 * editado (que já começou).
 */
export function periodProblem(
  draft: PeriodDraft,
  others: readonly UnavailabilityPeriod[],
  today: string,
  editing: UnavailabilityPeriod | null,
): Partial<Record<PeriodField, string>> {
  const errors: Partial<Record<PeriodField, string>> = {};
  const { start, end } = draft;
  const max = addDaysIso(today, UNAVAILABILITY_LIMITS.horizonDays);
  if (!start) errors.start = PERIOD_MSG.start;
  else if (start < today && start !== editing?.start) errors.start = PERIOD_MSG.past;
  else if (start > max) errors.start = PERIOD_MSG.horizon;
  if (!end) errors.end = PERIOD_MSG.end;
  else if (start && end < start) errors.end = PERIOD_MSG.order;
  else if (end > max) errors.end = PERIOD_MSG.horizon;
  else if (start && others.some((other) => other.start <= end && start <= other.end)) errors.end = PERIOD_MSG.overlap;
  return errors;
}

/** O período em que hoje está ("Agora"), ou null. */
export function currentPeriod(periods: readonly UnavailabilityPeriod[] | null | undefined, today: string): UnavailabilityPeriod | null {
  return unavailableOn(periods, today);
}

/** O período para o leitor de tela: "De 20/12/2026 a 05/01/2027" ou "Dia 20/12/2026"; o de hoje, ", agora". */
export function periodSpoken(period: UnavailabilityPeriod, today: string): string {
  const text = period.start === period.end ? `Dia ${periodText(period)}` : `De ${periodText(period)}`;
  return period.start <= today && today <= period.end ? `${text}, agora` : text;
}

/**
 * A linha "Dias e horários" de Configurações: no período de hoje, "Indisponível até 05/01" ("até 05/01/2027" em outro
 * ano); senão os turnos (availabilitySummary); sem turno, "Não informados". Período só no futuro não aparece aqui.
 */
export function scheduleSummary(
  slots: readonly string[],
  periods: readonly UnavailabilityPeriod[] | undefined,
  today: string,
): string {
  const now = currentPeriod(periods, today);
  if (now) return `Indisponível ${periodShort(now, today)}`;
  return slots.length ? availabilitySummary(slots) : "Não informados";
}

/** Datas "AAAA-MM-DD" em ordem (o texto já ordena). */
const compareDay = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** O corpo do PATCH: os períodos pelo início; o gravado vai com o `id` e o novo, sem. */
function body(list: readonly UnavailabilityIn[]): UnavailabilityIn[] {
  return [...list]
    .sort((a, b) => compareDay(a.start, b.start) || compareDay(a.end, b.end))
    .map((item) => (item.id ? { id: item.id, start: item.start, end: item.end } : { start: item.start, end: item.end }));
}

/**
 * Incluir (sem `id`) ou salvar o editado (com o `id`, no lugar dele): o corpo com a lista gravada agora. null: o editado
 * já saiu da lista (PERIOD_MSG.gone).
 */
export function unavailabilityWith(list: readonly UnavailabilityPeriod[], entry: UnavailabilityIn): UnavailabilityIn[] | null {
  if (!entry.id) return body([...list, entry]);
  if (!list.some((item) => item.id === entry.id)) return null;
  return body(list.map((item) => (item.id === entry.id ? { id: item.id, start: entry.start, end: entry.end } : item)));
}

/** Excluir: o corpo com a lista gravada agora, sem o período `id`. */
export function unavailabilityWithout(list: readonly UnavailabilityPeriod[], id: string): UnavailabilityIn[] {
  return body(list.filter((item) => item.id !== id));
}
