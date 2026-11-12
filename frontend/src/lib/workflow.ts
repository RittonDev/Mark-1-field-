// Regras de transição espelhadas de workflow.user_can_transition / validate_transition.
// Usadas só para pré-filtrar o arraste no quadro; a API valida de novo.

import {
  canManageTickets,
  SELF_ASSIGN_ROLES,
  STATUS,
  TRANSITIONS,
  UNTOUCHED_STATUSES,
} from "./constants";
import type { TicketListItem, TicketStatus, User } from "./types";

export function userCanTransition(user: User, ticket: TicketListItem, to: TicketStatus): boolean {
  if (canManageTickets(user.role)) return true;
  // Técnico de campo: só nas OS em que o analista o colocou como responsável.
  if (user.role === "technician") return ticket.assignee?.id === user.id;
  // Solicitante: a lista não traz requester_id; o quadro não é usado por solicitantes.
  if (to === "cancelled") return UNTOUCHED_STATUSES.includes(ticket.status);
  return ticket.status === "resolved" && (to === "closed" || to === "reopened");
}

export function allowedTargets(user: User | null, ticket: TicketListItem): TicketStatus[] {
  if (!user) return [];
  return TRANSITIONS[ticket.status].filter((to) => {
    // Sem responsável, só analista/técnico consegue (assume a OS automaticamente).
    if (STATUS[to].requiresAssignee && !ticket.assignee && !SELF_ASSIGN_ROLES.includes(user.role)) {
      return false;
    }
    return userCanTransition(user, ticket, to);
  });
}

/** Campos exigidos pelo destino (validate_transition no backend). */
export function transitionRequirements(to: TicketStatus) {
  return {
    needsSchedule: to === "scheduled",
    needsResolution: to === "resolved",
    needsNote: to === "cancelled" || to === "reopened",
    offersLocation: to === "en_route" || to === "in_progress",
  };
}
