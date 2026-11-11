// Porta de backend/app/services/sla.py::compute_sla_status.
// O servidor manda `sla_status` calculado na hora do pull; offline o relógio continua,
// então o app recalcula com os prazos que já tem para o selo não ficar parado em "No prazo".

import type { SlaStatus, TicketListItem } from "./types";

const AT_RISK_RATIO = 0.75; // SLA_AT_RISK_RATIO no backend

const ms = (value: string | null) => (value ? new Date(value).getTime() : null);

function elapsedRatio(createdAt: number, due: number, pausedS: number, now: number): number {
  const total = (due - createdAt) / 1000 - pausedS;
  if (total <= 0) return 1;
  const elapsed = (now - createdAt) / 1000 - pausedS;
  return elapsed / total;
}

export function computeSlaStatus(ticket: TicketListItem, now: number = Date.now()): SlaStatus {
  if (ticket.status === "cancelled") return "ok";
  const resolvedAt = ms(ticket.resolved_at);
  const resolutionDue = ms(ticket.resolution_due_at);
  const responseDue = ms(ticket.response_due_at);
  const pausedAt = ms(ticket.sla_paused_at);

  if (resolvedAt !== null && (ticket.status === "resolved" || ticket.status === "closed")) {
    if (resolutionDue === null || resolvedAt <= resolutionDue) return "met";
    return "breached";
  }

  const clock = pausedAt ?? now;
  const responseBreached = ticket.first_response_at === null && responseDue !== null && clock > responseDue;
  const resolutionBreached = resolutionDue !== null && clock > resolutionDue;
  if (responseBreached || resolutionBreached) return "breached";
  if (pausedAt !== null) return "paused";

  const createdAt = new Date(ticket.created_at).getTime();
  const pausedS = ticket.sla_paused_seconds ?? 0;
  const ratios: number[] = [];
  if (resolutionDue !== null) ratios.push(elapsedRatio(createdAt, resolutionDue, pausedS, now));
  if (ticket.first_response_at === null && responseDue !== null) {
    ratios.push(elapsedRatio(createdAt, responseDue, pausedS, now));
  }
  if (ratios.length && Math.max(...ratios) >= AT_RISK_RATIO) return "at_risk";
  return "ok";
}
