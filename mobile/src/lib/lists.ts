// Listas do técnico a partir das OS locais. O técnico só trabalha nas OS que o analista
// atribuiu a ele (o backend já filtra; aqui também, por segurança, caso o aparelho tenha dados antigos).

import { PRIORITY, STATUS } from "./constants";
import { addDays, startOfDay } from "./format";
import type { LocalTicket } from "./syncTypes";
import type { TicketStatus, User } from "./types";

const FIELD_RANK: Partial<Record<TicketStatus, number>> = { in_progress: 0, en_route: 1 };

/** Status em que a OS está parada esperando alguém (peça, cliente): sem nada a fazer até a central reagendar. */
const ON_HOLD: TicketStatus[] = ["on_hold_customer", "on_hold_vendor"];

/** O aparelho guarda as OS encerradas por 30 dias (db.pruneOld); antes disso o histórico é da central. */
export const LOCAL_HISTORY_DAYS = 30;

const time = (value: string | null | undefined) => (value ? new Date(value).getTime() : Number.POSITIVE_INFINITY);

/**
 * Concluída ou encerrada (resolvida, fechada ou cancelada). Status que o app ainda não conhece (servidor
 * mais novo que o app) contam como abertos, em vez de derrubar a tela.
 */
export const isDone = (status: TicketStatus) => {
  const info = STATUS[status];
  return info ? info.group === "done" || info.final : false;
};

/** Quando a OS foi concluída/encerrada: a data que vale para "Concluídas" (não a última edição). */
export const finishedAt = (ticket: Pick<LocalTicket, "resolved_at" | "closed_at" | "cancelled_at" | "updated_at">) =>
  ticket.resolved_at ?? ticket.closed_at ?? ticket.cancelled_at ?? ticket.updated_at;

/** Responsável pela OS (inicia, conclui, preenche formulários e colhe a assinatura). */
export const isMine = (ticket: LocalTicket, user: User) => ticket.assignee?.id === user.id;

/** Outro técnico da visita: vê a OS, aponta horas e manda fotos; o resto fica com o responsável. */
export const isHelper = (ticket: Pick<LocalTicket, "assignee" | "helpers">, user: Pick<User, "id">) =>
  ticket.assignee?.id !== user.id && (ticket.helpers ?? []).some((h) => h.id === user.id);

/** Na visita: responsável ou auxiliar. É o que entra em Hoje, Agenda e Concluídas. */
export const onVisit = (ticket: LocalTicket, user: User) => isMine(ticket, user) || isHelper(ticket, user);

/**
 * Visita improdutiva registrada e ainda sem nova agenda: a OS voltou para a central reagendar,
 * então sai de "Hoje" e do calendário até ganhar uma nova visita.
 */
export const awaitingReschedule = (ticket: LocalTicket) =>
  ticket.status === "assigned" && !ticket.scheduled_start && Boolean(ticket.last_unproductive_at);

/**
 * Parada esperando a central: improdutiva sem nova agenda, ou aguardando peça/cliente sem visita marcada
 * para hoje em diante. Não entra no trabalho do dia (nem na contagem da aba).
 */
export function awaitingCentral(ticket: LocalTicket, todayStart: number): boolean {
  if (awaitingReschedule(ticket)) return true;
  if (!ON_HOLD.includes(ticket.status)) return false;
  return time(ticket.scheduled_start) < todayStart || !ticket.scheduled_start;
}

/** Por que a OS está esperando a central (rótulo do cartão em "Aguardando a central"). */
export function waitingReason(ticket: LocalTicket): string {
  if (ticket.status === "on_hold_vendor") return "Aguardando peça ou fornecedor";
  if (ticket.status === "on_hold_customer") return "Aguardando o cliente";
  return "Visita improdutiva: aguardando nova agenda";
}

/**
 * Ordem do dia (a lista de Hoje é por horário, manhã primeiro): o que está em campo, depois a hora da
 * visita, e as sem agenda no fim; empate pela prioridade. Atraso e risco de chegada aparecem no ponto do
 * trilho, na linha do relógio e no resumo, sem embaralhar os horários.
 */
export function compareForToday(a: LocalTicket, b: LocalTicket): number {
  const rank = (FIELD_RANK[a.status] ?? 9) - (FIELD_RANK[b.status] ?? 9);
  if (rank) return rank;
  const sched = time(a.scheduled_start) - time(b.scheduled_start);
  if (sched) return sched;
  const prio = (PRIORITY[a.priority]?.rank ?? 9) - (PRIORITY[b.priority]?.rank ?? 9);
  if (prio) return prio;
  return time(a.resolution_due_at) - time(b.resolution_due_at);
}

export interface TicketLists {
  /** Em campo, agendadas para hoje (ou atrasadas) e as sem agenda. */
  today: LocalTicket[];
  /** Agendadas para os próximos dias. */
  upcoming: LocalTicket[];
  /** Resolvidas/fechadas nos últimos 7 dias (pela data da conclusão). */
  done: LocalTicket[];
  /** Paradas esperando a central: improdutiva sem nova agenda ou aguardando peça/cliente. */
  waiting: LocalTicket[];
  /** Canceladas pela central hoje ou com visita marcada para hoje: o técnico não deve ir. */
  cancelledToday: LocalTicket[];
}

const sameDay = (value: string | null | undefined, dayStart: number) => {
  if (!value) return false;
  const at = new Date(value).getTime();
  return at >= dayStart && at < addDays(new Date(dayStart), 1).getTime();
};

/** Entra no trabalho de hoje: aberta, não esperando a central, e em campo, sem agenda ou com visita até hoje. */
function belongsToToday(ticket: LocalTicket, todayStart: number, tomorrowStart: number): boolean {
  if (isDone(ticket.status) || awaitingCentral(ticket, todayStart)) return false;
  const scheduled = ticket.scheduled_start ? new Date(ticket.scheduled_start).getTime() : null;
  return scheduled === null || scheduled < tomorrowStart || FIELD_RANK[ticket.status] !== undefined;
}

export function buildLists(tickets: LocalTicket[], user: User, now: Date = new Date()): TicketLists {
  const today: LocalTicket[] = [];
  const upcoming: LocalTicket[] = [];
  const done: LocalTicket[] = [];
  const waiting: LocalTicket[] = [];
  const cancelledToday: LocalTicket[] = [];
  const todayStart = startOfDay(now).getTime();
  const tomorrowStart = addDays(startOfDay(now), 1).getTime();
  const weekAgo = addDays(startOfDay(now), -7).getTime();

  for (const ticket of tickets) {
    if (!onVisit(ticket, user)) continue;
    if (ticket.status === "cancelled") {
      // Cancelada não é "concluída": o parceiro é pago por chamado. Some do dia, mas com aviso.
      if (sameDay(ticket.cancelled_at ?? ticket.updated_at, todayStart) || sameDay(ticket.scheduled_start, todayStart)) {
        cancelledToday.push(ticket);
      }
      continue;
    }
    if (isDone(ticket.status)) {
      if (time(finishedAt(ticket)) >= weekAgo) done.push(ticket);
      continue;
    }
    if (awaitingCentral(ticket, todayStart)) {
      waiting.push(ticket);
      continue;
    }
    if (belongsToToday(ticket, todayStart, tomorrowStart)) today.push(ticket);
    else upcoming.push(ticket);
  }

  today.sort(compareForToday);
  upcoming.sort((a, b) => time(a.scheduled_start) - time(b.scheduled_start));
  done.sort((a, b) => time(finishedAt(b)) - time(finishedAt(a)));
  waiting.sort((a, b) => time(b.last_unproductive_at ?? b.updated_at) - time(a.last_unproductive_at ?? a.updated_at));
  cancelledToday.sort((a, b) => time(a.scheduled_start) - time(b.scheduled_start));
  return { today, upcoming, done, waiting, cancelledToday };
}

/** A OS ocupa o dia pela agenda (início/fim da visita)? Canceladas saem dos dias de hoje em diante. */
function scheduledOn(ticket: LocalTicket, dayStart: number, dayEnd: number, todayStart: number): boolean {
  if (!ticket.scheduled_start) return false;
  if (ticket.status === "cancelled" && dayStart >= todayStart) return false;
  const s = new Date(ticket.scheduled_start).getTime();
  const e = ticket.scheduled_end ? new Date(ticket.scheduled_end).getTime() : s;
  return s < dayEnd && e >= dayStart;
}

/**
 * OS do técnico que ocupam um dia: visita agendada naquele dia. Hoje inclui também o trabalho do dia
 * (em campo, sem agenda, atrasadas), igual à aba Hoje, para as contagens baterem.
 */
export function ticketsOnDay(tickets: LocalTicket[], user: User, day: Date, now: Date = new Date()): LocalTicket[] {
  const start = startOfDay(day).getTime();
  const end = addDays(startOfDay(day), 1).getTime();
  const todayStart = startOfDay(now).getTime();
  const isToday = start === todayStart;
  return tickets
    .filter((t) => onVisit(t, user))
    .filter((t) => scheduledOn(t, start, end, todayStart) || (isToday && belongsToToday(t, todayStart, end)))
    .sort(compareForToday);
}

/**
 * Agenda de vários dias numa passada só (grade do mês/semana): para cada dia, as OS da visita. O dia de
 * hoje usa a mesma regra de `ticketsOnDay`.
 */
export function ticketsByDay(tickets: LocalTicket[], user: User, days: Date[], now: Date = new Date()): Map<number, LocalTicket[]> {
  const map = new Map<number, LocalTicket[]>();
  if (!days.length) return map;
  for (const day of days) map.set(startOfDay(day).getTime(), []);
  const todayStart = startOfDay(now).getTime();
  const tomorrowStart = addDays(startOfDay(now), 1).getTime();
  const first = startOfDay(days[0]).getTime();
  const last = addDays(startOfDay(days[days.length - 1]), 1).getTime();
  for (const ticket of tickets) {
    if (!onVisit(ticket, user)) continue;
    const today = map.get(todayStart);
    if (today && belongsToToday(ticket, todayStart, tomorrowStart) && !scheduledOn(ticket, todayStart, tomorrowStart, todayStart)) {
      today.push(ticket);
    }
    if (!ticket.scheduled_start) continue;
    const s = new Date(ticket.scheduled_start).getTime();
    const e = ticket.scheduled_end ? new Date(ticket.scheduled_end).getTime() : s;
    if (e < first || s >= last) continue;
    for (let d = startOfDay(new Date(Math.max(s, first))); d.getTime() < last && d.getTime() <= e; d = addDays(d, 1)) {
      const dayStart = d.getTime();
      if (scheduledOn(ticket, dayStart, addDays(d, 1).getTime(), todayStart)) map.get(dayStart)?.push(ticket);
    }
  }
  for (const list of map.values()) list.sort(compareForToday);
  return map;
}
