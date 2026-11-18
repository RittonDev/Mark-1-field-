// Regras de transição espelhadas de workflow.validate_transition (a API valida de novo).

import type { TicketStatus } from "./types";

/** Campos exigidos pelo destino (validate_transition no backend). */
export function transitionRequirements(to: TicketStatus) {
  return {
    needsSchedule: to === "scheduled",
    needsResolution: to === "resolved",
    needsNote: to === "cancelled" || to === "reopened",
    offersLocation: to === "en_route" || to === "in_progress",
  };
}
