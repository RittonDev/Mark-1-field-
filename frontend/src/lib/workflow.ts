// Regras de transição espelhadas de workflow.user_can_transition / validate_transition.
// Usadas só para pré-filtrar o arraste no quadro; a API valida de novo.

import { STATUS, TRANSITIONS, UNTOUCHED_STATUSES } from "./constants";
import type { TicketListItem, TicketStatus, User } from "./types";

export function userCanTransition(user: User, ticket: TicketListItem, to: TicketStatus): boolean {
  if (user.role === "admin" || user.role === "supervisor") return true;
  if (user.role === "analyst") {
    if (ticket.assignee?.id === user.id) return true;
    return ticket.team !== null && ticket.team.id === user.team_id;
  }
  // Solicitante: a lista não traz requester_id; o quadro não é usado por solicitantes.
  if (to === "cancelled") return UNTOUCHED_STATUSES.includes(ticket.status);
  return ticket.status === "resolved" && (to === "closed" || to === "reopened");
}

export function allowedTargets(user: User | null, ticket: TicketListItem): TicketStatus[] {
  if (!user) return [];
  return TRANSITIONS[ticket.status].filter((to) => {
    if (STATUS[to].requiresAssignee && !ticket.assignee) return false;
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
