// Listas do técnico a partir das OS locais. O técnico só trabalha nas OS que o analista
// atribuiu a ele (o backend já filtra; aqui também, por segurança, caso o aparelho tenha dados antigos).

import { PRIORITY, STATUS } from "./constants";
import { arrivalUrgency } from "./field";
import { addDays, startOfDay } from "./format";
import type { LocalTicket } from "./syncTypes";
import type { TicketStatus, User } from "./types";

const FIELD_RANK: Partial<Record<TicketStatus, number>> = { in_progress: 0, en_route: 1 };

const time = (value: string | null) => (value ? new Date(value).getTime() : Number.POSITIVE_INFINITY);

export const isDone = (status: TicketStatus) => STATUS[status].group === "done" || STATUS[status].final;

export const isMine = (ticket: LocalTicket, user: User) => ticket.assignee?.id === user.id;

/**
 * Visita improdutiva registrada e ainda sem nova agenda: a OS voltou para a central reagendar,
 * então sai de "Hoje" e do calendário até ganhar uma nova visita.
 */
export const awaitingReschedule = (ticket: LocalTicket) =>
  ticket.status === "assigned" && !ticket.scheduled_start && Boolean(ticket.last_unproductive_at);

/**
 * Urgência do dia: chegada atrasada primeiro, depois chegada em risco; em seguida o que está
 * em campo, a hora da visita, a prioridade e o prazo de solução.
 */
export function compareForToday(a: LocalTicket, b: LocalTicket, now: number = Date.now()): number {
  const urgency = arrivalUrgency(a, now) - arrivalUrgency(b, now);
  if (urgency) return urgency;
  const rank = (FIELD_RANK[a.status] ?? 9) - (FIELD_RANK[b.status] ?? 9);
  if (rank) return rank;
  const sched = time(a.scheduled_start) - time(b.scheduled_start);
  if (sched) return sched;
  const prio = PRIORITY[a.priority].rank - PRIORITY[b.priority].rank;
  if (prio) return prio;
  return time(a.resolution_due_at) - time(b.resolution_due_at);
}

export interface TicketLists {
  /** Em campo, agendadas para hoje (ou atrasadas) e as sem agenda. */
  today: LocalTicket[];
  /** Agendadas para os próximos dias. */
  upcoming: LocalTicket[];
  /** Resolvidas/fechadas recentemente (últimos 7 dias). */
  done: LocalTicket[];
  /** Visita improdutiva, aguardando a central reagendar. */
  reschedule: LocalTicket[];
}

export function buildLists(tickets: LocalTicket[], user: User, now: Date = new Date()): TicketLists {
  const today: LocalTicket[] = [];
  const upcoming: LocalTicket[] = [];
  const done: LocalTicket[] = [];
  const reschedule: LocalTicket[] = [];
  const tomorrowStart = addDays(startOfDay(now), 1).getTime();
  const weekAgo = addDays(startOfDay(now), -7).getTime();

  for (const ticket of tickets) {
    if (!isMine(ticket, user)) continue;
    if (isDone(ticket.status)) {
      if (new Date(ticket.updated_at).getTime() >= weekAgo) done.push(ticket);
      continue;
    }
    if (awaitingReschedule(ticket)) {
      reschedule.push(ticket);
      continue;
    }
    const scheduled = ticket.scheduled_start ? new Date(ticket.scheduled_start).getTime() : null;
    if (scheduled !== null && scheduled >= tomorrowStart && FIELD_RANK[ticket.status] === undefined) upcoming.push(ticket);
    else today.push(ticket);
  }

  const at = now.getTime();
  today.sort((a, b) => compareForToday(a, b, at));
  upcoming.sort((a, b) => time(a.scheduled_start) - time(b.scheduled_start));
  done.sort((a, b) => time(b.updated_at) - time(a.updated_at));
  reschedule.sort((a, b) => time(b.last_unproductive_at) - time(a.last_unproductive_at));
  return { today, upcoming, done, reschedule };
}

/** OS do técnico que ocupam um dia: visita agendada naquele dia (ou atendimento em curso, se for hoje). */
export function ticketsOnDay(tickets: LocalTicket[], user: User, day: Date, now: Date = new Date()): LocalTicket[] {
  const start = startOfDay(day).getTime();
  const end = addDays(startOfDay(day), 1).getTime();
  const isToday = start === startOfDay(now).getTime();
  return tickets
    .filter((t) => isMine(t, user))
    .filter((t) => {
      const s = t.scheduled_start ? new Date(t.scheduled_start).getTime() : null;
      const e = t.scheduled_end ? new Date(t.scheduled_end).getTime() : s;
      if (s !== null && e !== null && s < end && e >= start) return true;
      return isToday && !isDone(t.status) && !awaitingReschedule(t) && (s === null || FIELD_RANK[t.status] !== undefined);
    })
    .sort((a, b) => compareForToday(a, b, now.getTime()));
}
