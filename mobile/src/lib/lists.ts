// Montagem das listas "Hoje", "Agenda" e "Equipe" a partir das OS locais.

import { PRIORITY, STATUS } from "./constants";
import { addDays, startOfDay } from "./format";
import type { LocalTicket } from "./syncTypes";
import type { TicketStatus, User } from "./types";

const FIELD_RANK: Partial<Record<TicketStatus, number>> = { in_progress: 0, en_route: 1 };

const time = (value: string | null) => (value ? new Date(value).getTime() : Number.POSITIVE_INFINITY);

export const isDone = (status: TicketStatus) => STATUS[status].group === "done" || STATUS[status].final;

/** Em campo primeiro, depois pela hora da visita, prioridade e prazo de solução. */
export function compareForToday(a: LocalTicket, b: LocalTicket): number {
  const rank = (FIELD_RANK[a.status] ?? 9) - (FIELD_RANK[b.status] ?? 9);
  if (rank) return rank;
  const sched = time(a.scheduled_start) - time(b.scheduled_start);
  if (sched) return sched;
  const prio = PRIORITY[a.priority].rank - PRIORITY[b.priority].rank;
  if (prio) return prio;
  return time(a.resolution_due_at) - time(b.resolution_due_at);
}

export interface AgendaDay {
  day: Date;
  items: LocalTicket[];
}

export interface TicketLists {
  /** Minhas OS para hoje: em campo, agendadas para hoje ou atrasadas e as sem agenda. */
  today: LocalTicket[];
  /** Minhas visitas agendadas, de hoje em diante, agrupadas por dia. */
  agenda: AgendaDay[];
  /** OS do meu grupo ou da fila sem grupo que não estão comigo. */
  team: LocalTicket[];
}

export function buildLists(tickets: LocalTicket[], user: User, now: Date = new Date()): TicketLists {
  const today: LocalTicket[] = [];
  const team: LocalTicket[] = [];
  const byDay = new Map<number, LocalTicket[]>();
  const todayStart = startOfDay(now).getTime();
  const tomorrowStart = addDays(startOfDay(now), 1).getTime();

  for (const ticket of tickets) {
    if (isDone(ticket.status)) continue;
    if (ticket.assignee?.id !== user.id) {
      team.push(ticket);
      continue;
    }
    const scheduled = ticket.scheduled_start ? new Date(ticket.scheduled_start).getTime() : null;
    if (scheduled === null || scheduled < tomorrowStart || FIELD_RANK[ticket.status] !== undefined) {
      today.push(ticket);
    }
    if (scheduled !== null && scheduled >= todayStart) {
      const key = startOfDay(new Date(scheduled)).getTime();
      const list = byDay.get(key) ?? [];
      list.push(ticket);
      byDay.set(key, list);
    }
  }

  today.sort(compareForToday);
  team.sort((a, b) => PRIORITY[a.priority].rank - PRIORITY[b.priority].rank || time(a.resolution_due_at) - time(b.resolution_due_at));
  const agenda = [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, items]) => ({ day: new Date(day), items: items.sort((a, b) => time(a.scheduled_start) - time(b.scheduled_start)) }));
  return { today, agenda, team };
}
