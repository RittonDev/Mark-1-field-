// Lembretes da visita: três notificações locais por OS, 1 dia (24 h), 1h40 e 10 min antes do início da visita
// (scheduled_start), para o responsável e para os outros técnicos da visita. São locais: funcionam offline, com o
// app fechado e no Expo Go; o servidor não agenda nada.
//
// Puro (sem import nativo, dá para testar fora do app): aqui só o plano e os textos. O agendamento e a
// reconciliação ficam em notifications.ts.

import { addressOf } from "./address";
import { awaitingNewVisit, relativeDay } from "./field";
import { formatTime, formatWeekdayDate } from "./format";
import type { TicketDetail, TicketStatus, UUID } from "./types";

export type VisitReminderKind = "day" | "leave" | "soon";

/** Antecedência de cada lembrete, contada do início da visita. */
export const VISIT_REMINDERS: readonly { kind: VisitReminderKind; minutes: number }[] = [
  { kind: "day", minutes: 1440 },
  { kind: "leave", minutes: 100 },
  { kind: "soon", minutes: 10 },
];

/** Identificadores: visit-day-<id>, visit-leave-<id> e visit-soon-<id>. */
export const VISIT_PREFIX = "visit-";
/**
 * O iOS guarda até 64 agendamentos por app: 48 lembretes, mais os alertas da loja (2 por OS em atendimento) e o
 * da jornada, ficam abaixo disso.
 */
export const MAX_VISIT_REMINDERS = 48;
/** Só agenda o que cabe nos próximos 7 dias (a janela anda a cada reconciliação). */
export const VISIT_HORIZON_MS = 7 * 86_400_000;
/** Lembrete novo só com 1 min de antecedência ou mais: nunca dispara atrasado. */
export const VISIT_MIN_LEAD_MS = 60_000;
/**
 * O lembrete já agendado fica até 15 min depois da hora dele (enquanto a visita não começa): sem o alarme exato, o
 * Android dispara com atraso e o pedido segue na lista do sistema até lá. Cancelado ali, ele se perderia.
 */
export const VISIT_KEEP_GRACE_MS = 15 * 60_000;
/** Diferença do relógio do aparelho para o do servidor que vale corrigir. */
const MIN_OFFSET_MS = 60_000;

const effectiveOffset = (offsetMs: number) => (Math.abs(offsetMs) >= MIN_OFFSET_MS ? offsetMs : 0);

/** `minutes` antes do início, no relógio do aparelho, arredondado para baixo ao minuto. */
const fireTime = (startMs: number, minutes: number, offset: number) =>
  Math.floor((startMs - minutes * 60_000 - offset) / 60_000) * 60_000;

/**
 * Visita ainda não iniciada. Em deslocamento, em atendimento, concluída, cancelada ou nova (ainda sem técnico)
 * não tem lembrete; a pausa da central (aguardando peça ou cliente) com visita marcada mantém.
 */
const REMINDABLE: TicketStatus[] = ["assigned", "scheduled", "reopened", "on_hold_customer", "on_hold_vendor"];

type VisitTicket = Pick<
  TicketDetail,
  "id" | "code" | "title" | "status" | "assignee" | "helpers" | "scheduled_start" | "last_unproductive_at" | "location" | "service_address"
>;

export interface PlannedReminder {
  /** visit-<kind>-<ticketId>. */
  identifier: string;
  ticketId: UUID;
  code: string;
  kind: VisitReminderKind;
  /** Hora do disparo no relógio do aparelho (ms), já arredondada ao minuto. */
  fireAt: number;
  /** A mesma hora em ISO (vai no `data.at`: reagendar muda a hora e troca o agendamento). */
  at: string;
  /** Início da visita (scheduled_start). */
  start: string;
  title: string;
  body: string;
}

/**
 * Visitas que merecem lembrete, pelo estado efetivo das OS no aparelho (com o que ainda está na fila): o técnico
 * vai à visita (responsável ou auxiliar), ela tem início marcado, ainda não começou e não está esperando a central
 * marcar outra visita depois de uma improdutiva. Devolve o início de cada uma, por OS.
 */
export function remindableVisits(tickets: readonly VisitTicket[], userId: UUID): Map<UUID, string> {
  const visits = new Map<UUID, string>();
  for (const ticket of tickets) {
    if (!ticket.scheduled_start || !REMINDABLE.includes(ticket.status) || awaitingNewVisit(ticket)) continue;
    const onVisit = ticket.assignee?.id === userId || (ticket.helpers ?? []).some((h) => h.id === userId);
    if (onVisit) visits.set(ticket.id, ticket.scheduled_start);
  }
  return visits;
}

/**
 * Os lembretes da visita agora, os mais próximos primeiro (no máximo 48). `offsetMs`: quanto o relógio do servidor
 * está à frente do aparelho (getServerOffsetMs); a hora do disparo é a do aparelho. `minLeadMs`: a antecedência
 * mínima. O padrão (1 min) dá o que pode ser agendado; com -VISIT_KEEP_GRACE_MS vêm também os que venceram há pouco,
 * que só podem ficar (o agendado que o sistema ainda não disparou). Visita que já começou, pela hora, não tem nenhum.
 */
export function planVisitReminders(
  tickets: readonly VisitTicket[],
  userId: UUID,
  now: number,
  offsetMs: number,
  minLeadMs: number = VISIT_MIN_LEAD_MS,
): PlannedReminder[] {
  const offset = effectiveOffset(offsetMs);
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const planned: PlannedReminder[] = [];
  for (const [ticketId, start] of remindableVisits(tickets, userId)) {
    const ticket = byId.get(ticketId);
    const startMs = new Date(start).getTime();
    if (!ticket || !Number.isFinite(startMs) || now >= fireTime(startMs, 0, offset)) continue;
    for (const { kind, minutes } of VISIT_REMINDERS) {
      const fireAt = fireTime(startMs, minutes, offset);
      if (fireAt < now + minLeadMs || fireAt > now + VISIT_HORIZON_MS) continue;
      planned.push({
        identifier: `${VISIT_PREFIX}${kind}-${ticketId}`,
        ticketId,
        code: ticket.code,
        kind,
        fireAt,
        at: new Date(fireAt).toISOString(),
        start,
        title: reminderTitle(kind, ticket.code, start),
        body: reminderBody(ticket),
      });
    }
  }
  return planned.sort((a, b) => a.fireAt - b.fireAt || a.identifier.localeCompare(b.identifier)).slice(0, MAX_VISIT_REMINDERS);
}

/** Até quando cada lembrete vale na bandeja, em minutos antes do início: até a hora do seguinte, e o último até o início. */
const SHOWN_UNTIL: Record<VisitReminderKind, number> = { day: 100, leave: 10, soon: 0 };
const REMINDER_KIND = /^visit-(day|leave|soon)-/;

/**
 * O lembrete na bandeja (`identifier`: visit-<tipo>-<id>) ficou velho: o de 1 dia quando chega a hora do de 1h40, o de
 * 1h40 quando chega a do de 10 min e todos quando a visita começa (`start`, pelo relógio do servidor).
 */
export function reminderOutdated(identifier: string, start: string, now: number, offsetMs: number): boolean {
  const kind = REMINDER_KIND.exec(identifier)?.[1] as VisitReminderKind | undefined;
  const startMs = new Date(start).getTime();
  return !Number.isFinite(startMs) || now >= fireTime(startMs, kind ? SHOWN_UNTIL[kind] : 0, effectiveOffset(offsetMs));
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * "Sex 20/11 às 08:00 · OS-000123", "Em 1h40 · OS-000123 às 08:00", "Em 10 min · OS-000123 às 08:00". O de 1 dia leva a
 * data, e não "Amanhã": ele fica na bandeja e no dia da visita diria o dia errado.
 */
function reminderTitle(kind: VisitReminderKind, code: string, start: string): string {
  const time = formatTime(start);
  if (kind === "day") return `${capitalize(formatWeekdayDate(start))} às ${time} · ${code}`;
  return `${kind === "leave" ? "Em 1h40" : "Em 10 min"} · ${code} às ${time}`;
}

/** Loja e endereço do atendimento; sem os dois, o título da OS. */
function reminderBody(ticket: VisitTicket): string {
  const address = ticket.service_address?.trim() || addressOf(ticket.location);
  return [siteLine(ticket), address].filter(Boolean).join(" · ") || ticket.title;
}

/** "LJ001 · Loja Exemplo": código e nome da loja (null sem loja). */
export function siteLine(ticket: Pick<TicketDetail, "location">): string | null {
  const { location } = ticket;
  if (!location) return null;
  return [location.code, location.name].filter(Boolean).join(" · ") || null;
}

/**
 * "Visita sex 20/11 às 08:00 · LJ001 · Loja Exemplo": com a data, para o texto que fica na bandeja (notificação do
 * sistema e aviso guardado). Com `now`, o dia relativo ("Visita amanhã às 08:00 · …"), para o toast na hora. Sem
 * agenda, só a loja (sem loja, o título da OS).
 */
export function visitLine(ticket: Pick<TicketDetail, "title" | "location" | "scheduled_start">, now?: number): string {
  const site = siteLine(ticket);
  const start = ticket.scheduled_start;
  if (!start) return site ?? ticket.title;
  // Relativo: "hoje", "amanhã", "ontem"; outra data vira "em 20/11".
  const relative = now === undefined ? null : relativeDay(start, now);
  const day = relative === null ? formatWeekdayDate(start) : /^\d/.test(relative) ? `em ${relative}` : relative;
  const when = `Visita ${day} às ${formatTime(start)}`;
  return site ? `${when} · ${site}` : when;
}

/** "OS-000123", "OS-000123 e OS-000124", "OS-000123, OS-000124 e mais 1". */
export function codesLine(codes: readonly string[]): string {
  if (codes.length <= 1) return codes[0] ?? "";
  if (codes.length === 2) return `${codes[0]} e ${codes[1]}`;
  return `${codes[0]}, ${codes[1]} e mais ${codes.length - 2}`;
}
