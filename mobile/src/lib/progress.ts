import type { TicketDetail, TicketStatus } from "./types";

/** Etapas do atendimento em campo mostradas no stepper da OS. */
export const FIELD_STEPS = ["Deslocamento", "Chegada", "Atendimento", "Concluir"] as const;

export interface FieldProgress {
  /** Última etapa alcançada (-1 = nenhuma). */
  reached: number;
  /** A etapa alcançada ainda está em curso (deslocando, atendendo). */
  active: boolean;
  paused: boolean;
  /** 0–1: quanto da trilha está preenchido. */
  fill: number;
}

const BEFORE: TicketStatus[] = ["new", "triage", "assigned", "scheduled", "reopened"];

/**
 * Deslocamento = "Iniciar deslocamento" (en_route); Chegada = check-in ao iniciar o atendimento;
 * Atendimento = in_progress; Concluir = resolvida/fechada. Pausas mantêm a etapa já alcançada.
 */
export function fieldProgress(ticket: Pick<TicketDetail, "status" | "work_started_at" | "work_seconds">): FieldProgress | null {
  const { status } = ticket;
  if (status === "cancelled") return null;
  let reached = -1;
  let active = false;
  let paused = false;
  if (BEFORE.includes(status)) reached = -1;
  else if (status === "en_route") [reached, active] = [0, true];
  else if (status === "in_progress") [reached, active] = [2, true];
  else if (status === "resolved" || status === "closed") reached = 3;
  else {
    // on_hold_*: pausa no meio do atendimento (ou antes de chegar, se nunca atendeu).
    paused = true;
    reached = ticket.work_started_at || (ticket.work_seconds ?? 0) > 0 ? 2 : 0;
  }
  const last = FIELD_STEPS.length - 1;
  return { reached, active, paused, fill: Math.max(0, reached) / last };
}
