// Promessa de campo (maxxfield.com.br), sem dependências nativas para poder ser testada fora do app:
// - nas capitais o técnico chega em até 4h do pedido (`arrival_due_at`);
// - cada chamado inclui até 4h de técnico na loja, contadas da chegada (`arrived_at` → `onsite_due_at`);
// - peça só entra com orçamento aprovado e assinado pelo cliente (pedidos de peça).

import type { FieldRules, PartRequestStatus, TicketListItem, TicketStatus } from "./types";

/** Regras de campo (GET /settings/field). Valores da promessa enquanto o aparelho não baixou as da empresa. */
export const DEFAULT_FIELD_RULES: FieldRules = {
  arrival_hours_capital: 4,
  arrival_hours_interior: null,
  onsite_hours: 4,
  onsite_warning_minutes: 30,
};

let rules: FieldRules = DEFAULT_FIELD_RULES;

export function getFieldRules(): FieldRules {
  return rules;
}

/** Aceita a resposta da API só com os campos conhecidos e válidos (o resto fica no padrão). */
export function setFieldRules(next: Partial<FieldRules> | null | undefined) {
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);
  rules = {
    ...DEFAULT_FIELD_RULES,
    ...(next ?? {}),
    onsite_hours: num(next?.onsite_hours, DEFAULT_FIELD_RULES.onsite_hours),
    onsite_warning_minutes: num(next?.onsite_warning_minutes, DEFAULT_FIELD_RULES.onsite_warning_minutes),
  };
}

/** Chegada "em risco" quando faltam até 60 min (mesmo critério do quadro da web). */
export const ARRIVAL_RISK_MINUTES = 60;

const BEFORE_ARRIVAL: TicketStatus[] = ["assigned", "scheduled", "en_route"];
/** Status em que o técnico está (ou esteve há pouco) na loja: o relógio de permanência aparece. */
export const ONSITE_STATUSES: TicketStatus[] = ["in_progress", "on_hold_customer", "on_hold_vendor"];

const minutesBetween = (from: number, to: number) => Math.round((to - from) / 60_000);

type Clockable = Pick<
  TicketListItem,
  "status" | "arrival_due_at" | "arrived_at" | "onsite_due_at" | "arrival_status" | "onsite_status"
>;

export type ClockTone = "normal" | "risk" | "late";

export interface ArrivalClock {
  tone: ClockTone;
  /** Minutos até o prazo (negativo = atrasado). */
  left: number;
  dueAt: string;
}

/** Prazo de chegada, só antes do check-in (atribuída, agendada ou em deslocamento). */
export function arrivalClock(ticket: Clockable, now: number): ArrivalClock | null {
  if (ticket.arrived_at || !ticket.arrival_due_at || !BEFORE_ARRIVAL.includes(ticket.status)) return null;
  const left = minutesBetween(now, new Date(ticket.arrival_due_at).getTime());
  const tone: ClockTone =
    left < 0 || ticket.arrival_status === "late" ? "late" : ticket.arrival_status === "at_risk" || left <= ARRIVAL_RISK_MINUTES ? "risk" : "normal";
  return { tone, left, dueAt: ticket.arrival_due_at };
}

export type OnsiteState = "ok" | "warning" | "over";

export interface OnsiteClock {
  state: OnsiteState;
  /** 0..1 do tempo do chamado já usado. */
  ratio: number;
  elapsed: number;
  left: number;
  total: number;
}

/** Permanência na loja: da chegada até o limite do chamado (4h). */
export function onsiteClock(ticket: Clockable, now: number): OnsiteClock | null {
  if (!ticket.arrived_at || !ticket.onsite_due_at || !ONSITE_STATUSES.includes(ticket.status)) return null;
  const start = new Date(ticket.arrived_at).getTime();
  const end = new Date(ticket.onsite_due_at).getTime();
  const total = Math.max(1, minutesBetween(start, end));
  const elapsed = Math.max(0, minutesBetween(start, now));
  const left = minutesBetween(now, end);
  const state: OnsiteState =
    left <= 0 || ticket.onsite_status === "over"
      ? "over"
      : left <= rules.onsite_warning_minutes || ticket.onsite_status === "warning"
        ? "warning"
        : "ok";
  return { state, ratio: Math.min(1, elapsed / total), elapsed, left, total };
}

/** Chegada já registrada: "Chegou 13:42 · no prazo/com atraso". */
export function arrivalResult(ticket: Clockable): { at: string; late: boolean } | null {
  if (!ticket.arrived_at) return null;
  const late =
    ticket.arrival_status === "late" ||
    (Boolean(ticket.arrival_due_at) && new Date(ticket.arrived_at).getTime() > new Date(ticket.arrival_due_at!).getTime());
  return { at: ticket.arrived_at, late };
}

/**
 * Urgência na lista de Hoje: chegada atrasada primeiro, depois em risco, depois o restante.
 * Retorna 0 (atrasada), 1 (em risco) ou 2.
 */
export function arrivalUrgency(ticket: Clockable, now: number): number {
  const clock = arrivalClock(ticket, now);
  if (!clock) return 2;
  return clock.tone === "late" ? 0 : clock.tone === "risk" ? 1 : 2;
}

/** Previsão do limite na loja para o check-in feito offline (o servidor confirma no próximo sync). */
export function onsiteDueFrom(arrivedAt: string): string {
  return new Date(new Date(arrivedAt).getTime() + rules.onsite_hours * 3600_000).toISOString();
}

export const PART_STATUS: Record<PartRequestStatus, { label: string; tone: "warning" | "info" | "success" | "danger" | "muted" }> = {
  open: { label: "Aguardando orçamento", tone: "warning" },
  quoted: { label: "Orçamento enviado", tone: "info" },
  approved: { label: "Aprovada: pode instalar", tone: "success" },
  rejected: { label: "Recusada", tone: "danger" },
  cancelled: { label: "Cancelada", tone: "muted" },
};

/** Unidades rápidas no pedido de peça. */
export const PART_UNITS = ["un", "m", "cx", "kit", "par", "rolo"] as const;
