"use client";

import clsx from "clsx";
import { Hand, Pause, RotateCcw } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { PriorityBadge, SlaBadge, SlaCountdown, StatusBadge } from "@/components/badges";
import { InactiveChip } from "@/components/operacao/status";
import { ArrivalChip, awaitingNewVisit, OnsiteBar } from "@/components/ticket/FieldClock";
import { TicketLink } from "@/components/ticket/TicketLink";
import { SLA_STATUS, STATUS } from "@/lib/constants";
import { dayKey, formatDate, formatDateTime, formatMinutes, formatShort, formatTime, initials } from "@/lib/format";
import type { TicketListItem, UserRef, UUID } from "@/lib/types";

/** OS ainda aberta (nem resolvida, nem fechada, nem cancelada). */
export const isOpenTicket = (t: TicketListItem) => ["open", "active", "pending"].includes(STATUS[t.status].group);

/** Tolerância do "Atrasada": 30 min depois do horário (services/field.SCHEDULE_TOLERANCE). */
const LATE_AFTER_MINUTES = 30;

/**
 * Minutos de atraso da visita: atribuída ou agendada, 30 min ou mais depois do horário e sem improdutiva no
 * horário ou depois (a mesma regra do "Atrasada" da Minha fila, da Início e das Atividades do dia). Em
 * deslocamento ou em atendimento não é atraso de início.
 */
export function lateMinutes(t: TicketListItem, now: number): number | null {
  if (!t.scheduled_start || (t.status !== "assigned" && t.status !== "scheduled")) return null;
  const start = Date.parse(t.scheduled_start);
  // A visita aconteceu e deu improdutiva: a OS espera data nova, não está atrasada para começar.
  if (t.last_unproductive_at && Date.parse(t.last_unproductive_at) >= start) return null;
  const late = (now - start) / 60_000;
  return late >= LATE_AFTER_MINUTES ? late : null;
}

/**
 * Foi ao local, não atendeu e ainda não ganhou outra data (o "Improdutiva: reagendar" da Minha fila): em
 * aberto e fora de campo (de volta à loja, a visita está acontecendo).
 */
export function needsReschedule(t: TicketListItem): boolean {
  if (!isOpenTicket(t) || t.status === "en_route" || t.status === "in_progress") return false;
  return awaitingNewVisit(t);
}

/** Aguardando cliente ou fornecedor: sem técnico é o esperado. */
const waiting = (t: TicketListItem) => t.status === "on_hold_customer" || t.status === "on_hold_vendor";

const empty = <span className="text-xs text-ink-subtle">—</span>;

/** Identificador como no Field Control (o nº puro, em negrito): abre a OS no painel. */
export function IdentifierCell({ t }: { t: TicketListItem }) {
  return (
    <TicketLink
      ticketId={t.id}
      label={`OS ${t.number}: ${t.title}`}
      title={`${t.code} · ${t.title}`}
      className="rounded font-bold text-ink tabular-nums underline-offset-2 hover:text-brand-ink hover:underline"
    >
      {t.number}
    </TicketLink>
  );
}

/** Dia do agendamento (dd/mm/aaaa) e a hora embaixo; atraso em vermelho, como na Minha fila. */
export function ScheduleCell({ t, now }: { t: TicketListItem; now: number }) {
  const open = isOpenTicket(t);
  const late = open ? lateMinutes(t, now) : null;
  const reschedule = needsReschedule(t) ? (
    <span className="text-xs font-medium text-amber-700 dark:text-amber-300" title="O técnico foi ao local e não atendeu">
      Improdutiva: reagendar
    </span>
  ) : null;
  const start = t.scheduled_start;
  if (!start) {
    return (
      <div className="flex flex-col gap-0.5 whitespace-nowrap">
        <span className="text-xs text-ink-subtle">{open ? "Sem agenda" : "—"}</span>
        {reschedule}
      </div>
    );
  }
  const end = t.scheduled_end && dayKey(t.scheduled_end) === dayKey(start) ? formatTime(t.scheduled_end) : null;
  return (
    <div className="flex flex-col gap-0.5 whitespace-nowrap" title={`Agendada para ${formatDateTime(start)}`}>
      <span className={clsx("tabular-nums", open ? "text-ink" : "text-ink-muted")}>{formatDate(start)}</span>
      <span
        className={clsx("text-xs tabular-nums", late !== null ? "font-semibold text-red-700 dark:text-red-300" : "text-ink-subtle")}
      >
        {formatTime(start)}
        {end ? `–${end}` : ""}
        {late !== null ? ` · atrasada há ${formatMinutes(Math.max(1, late))}` : ""}
      </span>
      {reschedule}
    </div>
  );
}

export function CustomerCell({ t }: { t: TicketListItem }) {
  const name = t.customer?.name ?? t.requester_name;
  if (!name) return empty;
  return (
    <span className="block max-w-[14rem] truncate" title={name}>
      {name}
    </span>
  );
}

/**
 * Loja (nome) e, embaixo, o código (quando o nome não o traz) e a cidade. Duas ou mais OS na mesma loja
 * em 30 dias indicam problema que volta: o aviso fica em âmbar.
 */
export function LocationCell({ t }: { t: TicketListItem }) {
  const l = t.location;
  if (!l) return empty;
  const code = l.code && !l.name.includes(l.code) ? l.code : null;
  const town = l.city ? `${l.city}${l.state ? `/${l.state}` : ""}` : null;
  const detail = [code, town].filter(Boolean).join(" · ");
  const recurrence = t.recurrence_30d ?? 0;
  return (
    <div className="max-w-[18rem] min-w-[10rem]">
      <span className="block truncate" title={l.name}>
        {l.name}
      </span>
      {detail || recurrence >= 2 ? (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-subtle">
          {detail ? (
            <span className="truncate" title={detail}>
              {detail}
            </span>
          ) : null}
          {recurrence >= 2 ? (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 font-medium text-amber-700 dark:text-amber-300"
              title="Outras OS nesta loja nos últimos 30 dias"
            >
              <RotateCcw aria-hidden className="size-3" />
              {recurrence} OS em 30 dias
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export function StatusCell({ t }: { t: TicketListItem }) {
  return <StatusBadge status={t.status} />;
}

export function PriorityCell({ t }: { t: TicketListItem }) {
  return <PriorityBadge priority={t.priority} />;
}

/** Tipo de OS (o serviço que será feito). */
export function ServiceTypeCell({ t }: { t: TicketListItem }) {
  const name = t.service_type?.name;
  if (!name) return empty;
  return (
    <span className="block max-w-[12rem] truncate" title={name}>
      {name}
    </span>
  );
}

/** Escopo (o que deve ser feito): duas linhas, o texto inteiro no título. */
export function ScopeCell({ t }: { t: TicketListItem }) {
  const scope = t.description?.trim();
  if (!scope) return empty;
  return (
    <span className="line-clamp-2 max-w-[22rem] min-w-[14rem] text-xs leading-relaxed text-ink-muted" title={scope}>
      {scope}
    </span>
  );
}

/** Título da OS e, embaixo, o nº do chamado no sistema do cliente. */
export function TitleCell({ t }: { t: TicketListItem }) {
  return (
    <div className="max-w-[20rem] min-w-[12rem]">
      <span className="line-clamp-2" title={t.title}>
        {t.title}
      </span>
      {t.client_reference ? (
        <span className="block truncate text-xs text-ink-subtle" title={`Nº do chamado do cliente: ${t.client_reference}`}>
          Chamado do cliente: {t.client_reference}
        </span>
      ) : null}
    </div>
  );
}

/** Técnico responsável, quem vai junto e o grupo. */
export function TechnicianCell({ t }: { t: TicketListItem }) {
  if (!t.assignee) {
    // Sem técnico só é problema na OS em aberto que não está esperando o cliente ou o fornecedor.
    return isOpenTicket(t) && !waiting(t) ? <span className="text-xs font-medium text-amber-700 dark:text-amber-300">Sem técnico</span> : empty;
  }
  const helpers = t.helpers ?? [];
  const helperNames = helpers.map((h) => h.name).join(", ");
  return (
    <div className="max-w-[12rem]">
      <span className="flex min-w-0 items-center">
        {/* Nome longo corta com reticências (nome inteiro no título). */}
        <span
          className="truncate"
          title={t.assignee.is_active === false ? `${t.assignee.name} · sem acesso ao app` : t.assignee.name}
        >
          {t.assignee.name}
        </span>
        {/* Sem acesso ao app só pede ação na OS em aberto: liberar o acesso ou trocar o técnico. */}
        {t.assignee.is_active === false && isOpenTicket(t) ? <InactiveChip className="ml-1.5" /> : null}
        {helpers.length ? (
          <span
            className="ml-1.5 shrink-0 rounded-full bg-surface-2 px-1.5 py-px text-[11px] font-medium text-ink-muted ring-1 ring-line ring-inset"
            title={`Junto: ${helperNames}`}
          >
            <span aria-hidden>+{helpers.length}</span>
            <span className="sr-only">e junto: {helperNames}</span>
          </span>
        ) : null}
      </span>
      {t.team ? <span className="block truncate text-xs text-ink-subtle">{t.team.name}</span> : null}
    </div>
  );
}

// ------------------------------------------------------------------ analista (nome curto sem empate)

const PARTICLES = new Set(["da", "das", "de", "do", "dos", "e"]);

/** Formas do nome, da mais curta à mais completa: "Fulano", "Fulano T.", "Fulano Tal" e o nome inteiro. */
function nameForms(name: string): string[] {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? name;
  const last = words.slice(1).filter((w) => !PARTICLES.has(w.toLocaleLowerCase("pt-BR"))).at(-1);
  return last ? [first, `${first} ${last[0].toLocaleUpperCase("pt-BR")}.`, `${first} ${last}`, name] : [first, name];
}

/**
 * Nome curto do analista: o primeiro nome; com outro analista de mesmo primeiro nome na página, mais a
 * inicial do sobrenome ("Fulano T." e "Fulano B."); se ainda empatar, o sobrenome inteiro.
 */
function ownerLabel(name: string, others: readonly string[]): string {
  const mine = nameForms(name);
  const theirs = others.map(nameForms);
  for (let level = 0; level < mine.length; level++) {
    const key = mine[level].toLocaleLowerCase("pt-BR");
    if (!theirs.some((forms) => forms[Math.min(level, forms.length - 1)].toLocaleLowerCase("pt-BR") === key)) return mine[level];
  }
  return name;
}

// Analistas das linhas à mostra (id → nome e quantas linhas), para achar o primeiro nome repetido na
// página. Imutável: cada mudança troca o mapa e avisa as células.
type ShownOwners = ReadonlyMap<UUID, { name: string; rows: number }>;
let shownOwners: ShownOwners = new Map();
const ownerListeners = new Set<() => void>();

function changeShownOwners(id: UUID, name: string, delta: 1 | -1) {
  const next = new Map(shownOwners);
  const rows = (next.get(id)?.rows ?? 0) + delta;
  if (rows > 0) next.set(id, { name, rows });
  else next.delete(id);
  shownOwners = next;
  ownerListeners.forEach((listener) => listener());
}

/** Registra o analista da linha enquanto ela aparece e devolve os analistas da página (antes da pintura). */
function useShownOwners(owner: UserRef | null): ShownOwners {
  const [owners, setOwners] = useState(() => shownOwners);
  const id = owner?.id;
  const name = owner?.name;
  useLayoutEffect(() => {
    if (!id || !name) return;
    const listener = () => setOwners(shownOwners);
    ownerListeners.add(listener);
    changeShownOwners(id, name, 1);
    return () => {
      ownerListeners.delete(listener);
      changeShownOwners(id, name, -1);
    };
  }, [id, name]);
  return owners;
}

/** Analista que acompanha a OS (a fila dela) e o "Assumir", que puxa a OS para a fila de quem clica. */
export function OwnerCell({
  t,
  userId,
  onClaim,
  claiming,
}: {
  t: TicketListItem;
  userId: UUID | undefined;
  onClaim: (t: TicketListItem) => void;
  claiming: boolean;
}) {
  const owner = t.owner ?? null;
  const mine = Boolean(owner && owner.id === userId);
  const shown = useShownOwners(owner);
  const others = owner ? [...shown].filter(([id]) => id !== owner.id).map(([, o]) => o.name) : [];
  const label = owner && !mine ? ownerLabel(owner.name, others) : null;
  return (
    <div className="flex items-center gap-1.5">
      {owner ? (
        <>
          <span
            className={clsx(
              "flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
              mine ? "bg-brand text-white dark:bg-brand-strong" : "bg-surface-3 text-ink-muted",
            )}
            title={owner.name}
            aria-hidden
          >
            {initials(owner.name)}
          </span>
          <span className="max-w-[7rem] truncate text-xs text-ink-muted" title={owner.name}>
            {mine ? "Você" : label}
          </span>
        </>
      ) : (
        empty
      )}
      {isOpenTicket(t) && !mine ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClaim(t);
          }}
          disabled={claiming}
          className="-my-1 shrink-0 rounded-md p-1.5 text-ink-subtle transition-colors hover:bg-surface-3 hover:text-brand-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:opacity-40"
          aria-label={owner ? `Assumir a OS ${t.number} (hoje com ${owner.name})` : `Assumir a OS ${t.number}`}
          title={owner ? `Assumir: a OS sai da fila de ${owner.name} e vai para a sua` : "Assumir: a OS vai para a sua fila"}
        >
          <Hand aria-hidden className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/** Prazo do SLA: cor só para o problema (em risco, violado); no prazo, cumprido e pausado ficam neutros. */
export function SlaCell({ t }: { t: TicketListItem }) {
  const status = t.sla_status;
  return (
    <div className="flex max-w-[12rem] flex-col items-start gap-1">
      {status === "breached" || status === "at_risk" ? (
        <SlaBadge status={status} />
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
          {status === "paused" ? <Pause aria-hidden className="size-3" /> : null}
          {SLA_STATUS[status].label}
        </span>
      )}
      {status === "paused" ? null : <SlaCountdown ticket={t} />}
      {/* Prazo de chegada à loja (enquanto o técnico não chega) e o tempo na loja. */}
      {isOpenTicket(t) && !t.arrived_at ? <ArrivalChip ticket={t} compact /> : null}
      {t.status === "in_progress" ? <OnsiteBar ticket={t} className="mt-0.5" /> : null}
    </div>
  );
}

export function CreatedCell({ t }: { t: TicketListItem }) {
  return (
    <span className="text-xs whitespace-nowrap text-ink-muted tabular-nums" title={`Atualizada em ${formatDateTime(t.updated_at)}`}>
      {formatShort(t.created_at)}
    </span>
  );
}
