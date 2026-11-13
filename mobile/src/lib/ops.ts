// Aplicação otimista das operações da fila local sobre a OS vinda do servidor.
//
// O app guarda duas versões de cada OS: a última recebida do servidor e a "efetiva",
// que é a do servidor com as operações pendentes reaplicadas em ordem (rebase).
// Assim um pull no meio do caminho não apaga o que o técnico fez offline,
// e uma operação rejeitada some sozinha no próximo rebase.

import { SELF_ASSIGN_ROLES, STATUS, TRANSITIONS, UNTOUCHED_STATUSES } from "./constants";
import { actualSeconds, defaultEnd } from "./duration";
import { onsiteDueFrom } from "./field";
import { resolutionBreached, responseBreached } from "./sla";
import type { LocalPartRequest, LocalTicket, OutboxOp } from "./syncTypes";
import type { TicketDetail, TicketStatus, User, UserRef } from "./types";
import { userCanTransition } from "./workflow";

const selfAssigns = (user: User) => SELF_ASSIGN_ROLES.includes(user.role);

/** Status em que o responsável pode registrar visita improdutiva (UNPRODUCTIVE_FROM no backend). */
export const UNPRODUCTIVE_FROM: TicketStatus[] = ["assigned", "scheduled", "en_route", "in_progress"];

/**
 * Espelho de backend/app/services/tickets.py::allowed_transitions.
 * Diferente do quadro da web, analista e técnico podem levar uma OS sem responsável para
 * um status de campo: o servidor os define como responsável automaticamente (SELF_ASSIGN_ROLES).
 */
export function allowedTransitions(user: User, ticket: TicketDetail): TicketStatus[] {
  return TRANSITIONS[ticket.status].filter((to) => {
    if (!userCanTransition(user, ticket, to)) return false;
    if (STATUS[to].requiresAssignee && !ticket.assignee && !selfAssigns(user)) return false;
    return true;
  });
}

export function userRef(user: User): UserRef {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

const isoPlusMs = (iso: string | null, deltaMs: number) =>
  iso ? new Date(new Date(iso).getTime() + deltaMs).toISOString() : iso;

function applyTransition(ticket: TicketDetail, op: Extract<OutboxOp, { type: "transition" }>, user: User): TicketDetail {
  const p = op.payload;
  const from = ticket.status;
  const to = p.to_status;
  // Transição inválida: o servidor vai rejeitar; não fingimos que ela aconteceu.
  if (from === to || !TRANSITIONS[from].includes(to)) return ticket;

  const at = op.client_timestamp;
  const t: TicketDetail = { ...ticket };
  // Check-in: a chegada é a primeira entrada em "Em atendimento" (vale para a promessa de chegada).
  // O limite na loja é refeito a cada entrada (field.py::on_arrival / on_reentry): na primeira, as
  // horas inteiras do chamado; numa revisita ou retomada, o que sobrou depois do tempo já trabalhado.
  if (to === "in_progress") {
    if (!t.arrived_at) {
      t.arrived_at = at;
      t.arrival_status = t.arrival_due_at && new Date(at).getTime() > new Date(t.arrival_due_at).getTime() ? "late" : "met";
      t.onsite_due_at = onsiteDueFrom(at);
    } else {
      t.onsite_due_at = onsiteDueFrom(at, t.work_seconds);
    }
    t.onsite_status = "ok";
  }
  if (p.scheduled_start) {
    t.scheduled_start = p.scheduled_start;
    // Novo início sem fim: o fim vem da estimativa, e não sobra o de um agendamento antigo.
    t.scheduled_end = defaultEnd(p.scheduled_start, p.scheduled_end, t.estimated_minutes);
  } else if (p.scheduled_end) {
    t.scheduled_end = p.scheduled_end;
  }
  if (STATUS[to].requiresAssignee && !t.assignee && selfAssigns(user)) t.assignee = userRef(user);

  // Duração real: soma os trechos em "Em atendimento" (tickets.py::_change_status).
  if (from === "in_progress" && t.work_started_at) {
    t.work_seconds = actualSeconds(t, new Date(at).getTime());
    t.work_started_at = null;
  }
  if (to === "in_progress") t.work_started_at = at;

  // SLA: pausa nas pendências e, ao retomar, empurra os prazos ainda abertos (sla.py::resume).
  if (STATUS[to].slaPaused) {
    if (!t.sla_paused_at) t.sla_paused_at = at;
  } else if (t.sla_paused_at) {
    const delta = Math.max(0, new Date(at).getTime() - new Date(t.sla_paused_at).getTime());
    t.sla_paused_seconds = (t.sla_paused_seconds ?? 0) + Math.floor(delta / 1000);
    if (!t.first_response_at) t.response_due_at = isoPlusMs(t.response_due_at, delta);
    if (!t.resolved_at) t.resolution_due_at = isoPlusMs(t.resolution_due_at, delta);
    t.sla_paused_at = null;
  }
  if (UNTOUCHED_STATUSES.includes(from) && !UNTOUCHED_STATUSES.includes(to) && !t.first_response_at) {
    t.first_response_at = at;
  }
  if (to === "resolved") {
    t.resolved_at = at;
    if (p.resolution_notes) t.resolution_notes = p.resolution_notes;
  }
  if (to === "reopened") {
    t.resolved_at = null;
    t.reopen_count = (t.reopen_count ?? 0) + 1;
  }
  t.status = to;
  t.updated_at = at;
  t.allowed_transitions = allowedTransitions(user, t);

  // Violação de SLA (schemas/ticket.py): flags pelos prazos e pendência quando resolvida sem motivo.
  // O nome do motivo escolhido só chega no próximo sync; aqui basta saber que foi informado.
  const atMs = new Date(at).getTime();
  if (p.violation_note !== undefined) t.violation_note = p.violation_note?.trim() || null;
  t.response_breached = responseBreached(t, atMs);
  t.resolution_breached = resolutionBreached(t, atMs);
  const hasResponseReason = Boolean(p.response_violation_reason_id || t.response_violation_reason);
  const hasResolutionReason = Boolean(p.resolution_violation_reason_id || t.resolution_violation_reason);
  t.violation_reason_pending =
    (to === "resolved" || to === "closed") &&
    ((t.response_breached && !hasResponseReason) || (t.resolution_breached && !hasResolutionReason));
  return t;
}

/** Mesmas respostas, independente da ordem das chaves (o servidor pode devolver em outra ordem). */
function sameAnswers(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => k in b && JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

export function applyOp(ticket: TicketDetail, op: OutboxOp, user: User): TicketDetail {
  switch (op.type) {
    case "transition":
      return applyTransition(ticket, op, user);
    case "comment": {
      const t = { ...ticket, updated_at: op.client_timestamp };
      if (!op.payload.is_internal && !t.first_response_at && user.role !== "requester") {
        t.first_response_at = op.client_timestamp;
      }
      return t;
    }
    case "worklog":
      return { ...ticket, updated_at: op.client_timestamp };
    case "unproductive": {
      // Espelho de tickets.py::register_unproductive: volta para "Atribuído" sem agenda (a central
      // reagenda), o relógio do atendimento para e a ocorrência é contada.
      if (!UNPRODUCTIVE_FROM.includes(ticket.status)) return ticket;
      const at = op.client_timestamp;
      const t: TicketDetail = { ...ticket };
      if (t.status === "in_progress" && t.work_started_at) {
        t.work_seconds = actualSeconds(t, new Date(at).getTime());
        t.work_started_at = null;
      }
      t.status = "assigned";
      t.scheduled_start = null;
      t.scheduled_end = null;
      // O limite na loja fica como está (o servidor faz o mesmo): a próxima entrada em atendimento
      // o refaz com o que sobrou das horas do chamado.
      t.unproductive_count = (t.unproductive_count ?? 0) + 1;
      t.last_unproductive_at = at;
      t.updated_at = at;
      t.allowed_transitions = allowedTransitions(user, t);
      return t;
    }
    case "form_answers": {
      // Espelho de forms.py::save_partial/complete. A conclusão só é enfileirada depois da
      // validação local (obrigatórios e fotos); se o servidor recusar, o rebase desfaz.
      const p = op.payload;
      const forms = (ticket.forms ?? []).map((form) => {
        if (form.id !== p.form_id) return form;
        const answers = { ...form.answers };
        for (const [key, value] of Object.entries(p.answers)) {
          if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) delete answers[key];
          else answers[key] = value;
        }
        if (p.complete) {
          return {
            ...form,
            answers,
            status: "completed" as const,
            completed_at: op.client_timestamp,
            completed_by: { id: user.id, name: user.name },
          };
        }
        const changed = !sameAnswers(answers, form.answers);
        if (!changed && form.status === "completed") return form;
        return {
          ...form,
          answers,
          status: Object.keys(answers).length || form.status === "in_progress" ? ("in_progress" as const) : ("pending" as const),
          completed_at: null,
          completed_by: null,
        };
      });
      return { ...ticket, forms, updated_at: op.client_timestamp };
    }
    case "part_request": {
      // Aparece na hora como "Aguardando orçamento"; o do servidor substitui no próximo sync.
      const p = op.payload;
      const request: LocalPartRequest = {
        id: op.client_op_id,
        description: p.description,
        quantity: p.quantity,
        unit: p.unit || "un",
        note: p.note ?? null,
        status: "open",
        quote_id: null,
        quote_code: null,
        requested_by: { id: user.id, name: user.name },
        attachments: [],
        response_note: null,
        created_at: op.client_timestamp,
        pending: true,
      };
      return { ...ticket, part_requests: [...(ticket.part_requests ?? []), request], updated_at: op.client_timestamp };
    }
    case "update": {
      const p = op.payload;
      const t = { ...ticket, updated_at: op.client_timestamp };
      if (p.title) t.title = p.title;
      if (p.description !== undefined) t.description = p.description;
      if (p.scheduled_start !== undefined) t.scheduled_start = p.scheduled_start ?? null;
      if (p.scheduled_end !== undefined) t.scheduled_end = p.scheduled_end ?? null;
      return t;
    }
  }
}

/** Estado efetivo = servidor + operações pendentes daquela OS, na ordem da fila. */
export function rebase(server: TicketDetail, ops: OutboxOp[], user: User): LocalTicket {
  let ticket = server;
  for (const op of ops) ticket = applyOp(ticket, op, user);
  return { ...ticket, pending_ops: ops.length };
}
