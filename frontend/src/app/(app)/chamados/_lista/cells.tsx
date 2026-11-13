"use client";

import clsx from "clsx";
import { FolderKanban, Hand, Pause } from "lucide-react";
import { PriorityBadge, SlaBadge, SlaCountdown, StatusBadge } from "@/components/badges";
import { dayTimeLabel } from "@/components/new-ticket/dayTime";
import { TagChips } from "@/components/TagChips";
import { ArrivalChip, OnsiteBar, RecurrenceChip } from "@/components/ticket/FieldClock";
import { TicketLink } from "@/components/ticket/TicketLink";
import { SLA_STATUS, STATUS } from "@/lib/constants";
import { dayKey, formatMinutes, formatTime, initials } from "@/lib/format";
import type { TicketListItem, UUID } from "@/lib/types";

/** OS ainda aberta (nem resolvida, nem fechada, nem cancelada). */
export const isOpenTicket = (t: TicketListItem) => ["open", "active", "pending"].includes(STATUS[t.status].group);

/**
 * Minutos de atraso da visita: atribuída ou agendada e o horário marcado já passou (a mesma regra do
 * "Atrasada" da Minha fila). Em deslocamento ou em atendimento não é atraso de início.
 */
export function lateMinutes(t: TicketListItem, now: number): number | null {
  if (!t.scheduled_start || (t.status !== "assigned" && t.status !== "scheduled")) return null;
  const late = (now - new Date(t.scheduled_start).getTime()) / 60_000;
  return late > 0 ? late : null;
}

/** Foi ao local, não atendeu e ainda não ganhou outra data (o "Improdutiva: reagendar" da Minha fila). */
export function needsReschedule(t: TicketListItem): boolean {
  if (!t.last_unproductive_at || !isOpenTicket(t)) return false;
  return !t.scheduled_start || new Date(t.scheduled_start) < new Date(t.last_unproductive_at);
}

/** Aguardando cliente ou fornecedor: sem técnico é o esperado. */
const waiting = (t: TicketListItem) => t.status === "on_hold_customer" || t.status === "on_hold_vendor";

/** Loja como o analista fala dela: "041 · Shopping Iguatemi · Campinas". */
export function storeLabel(t: TicketListItem): string | null {
  if (!t.location) return null;
  return [t.location.code, t.location.name, t.location.city].filter(Boolean).join(" · ");
}

/** Nº, título e o que ajuda a reconhecer a OS (chamado do cliente, projeto, categoria, etiquetas). */
export function TicketTitleCell({ t, compact }: { t: TicketListItem; compact: boolean }) {
  return (
    <>
      <TicketLink ticketId={t.id} className="block font-semibold text-ink hover:text-brand-ink">
        {/* O nº nunca quebra no meio ("OS-" numa linha e o número na outra). */}
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] font-normal whitespace-nowrap text-ink-subtle">
          {t.code}
          {t.client_reference ? (
            <span className="truncate" title={`Nº do chamado do cliente: ${t.client_reference}`}>
              · {t.client_reference}
            </span>
          ) : null}
        </span>
        <span className={compact ? "block truncate" : "line-clamp-2"} title={t.title}>
          {t.title}
        </span>
      </TicketLink>
      {compact ? null : (
        <>
          {t.project || t.category ? (
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-subtle">
              {t.project ? (
                <span className="inline-flex shrink-0 items-center gap-1 font-medium text-ink-muted" title={`Projeto ${t.project.code} · ${t.project.name}`}>
                  <FolderKanban aria-hidden className="size-3" />
                  {t.project.code}
                </span>
              ) : null}
              {t.category ? (
                <span className="truncate" title={t.category.full_name}>
                  {t.category.full_name}
                </span>
              ) : null}
            </span>
          ) : null}
          {t.recurrence_30d || t.tags?.length ? (
            <span className="mt-1.5 flex flex-wrap gap-1">
              <RecurrenceChip count={t.recurrence_30d} />
              <TagChips tags={t.tags} max={2} />
            </span>
          ) : null}
        </>
      )}
    </>
  );
}

export function StatusCell({ t }: { t: TicketListItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <StatusBadge status={t.status} />
      <PriorityBadge priority={t.priority} compact />
    </div>
  );
}

/** Quando é a visita. Atraso em vermelho (como na Minha fila); aberta sem data diz "Sem agenda". */
export function AgendaCell({ t, now, compact }: { t: TicketListItem; now: number; compact: boolean }) {
  const open = isOpenTicket(t);
  const late = open ? lateMinutes(t, now) : null;
  const reschedule = needsReschedule(t);
  const rescheduleNote = reschedule ? (
    <span className="text-xs font-medium text-amber-700 dark:text-amber-300" title="O técnico foi ao local e não atendeu">
      Improdutiva: reagendar
    </span>
  ) : null;
  if (!t.scheduled_start) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-ink-subtle">{open ? "Sem agenda" : "—"}</span>
        {rescheduleNote}
      </div>
    );
  }
  const end = t.scheduled_end;
  const endLabel = end ? (dayKey(end) === dayKey(t.scheduled_start) ? formatTime(end) : dayTimeLabel(end, now, true)) : null;
  return (
    <div className="flex flex-col gap-0.5 whitespace-nowrap">
      <span className={clsx("text-sm tabular-nums", open ? "text-ink" : "text-ink-muted")}>{dayTimeLabel(t.scheduled_start, now)}</span>
      {late !== null ? (
        <span className="text-xs font-semibold text-red-700 dark:text-red-300">Atrasada há {formatMinutes(Math.max(1, late))}</span>
      ) : endLabel && !compact ? (
        <span className="text-xs text-ink-subtle tabular-nums">até {endLabel}</span>
      ) : null}
      {rescheduleNote}
    </div>
  );
}

/** Técnico responsável, quem vai junto e o grupo. */
export function TechnicianCell({ t }: { t: TicketListItem }) {
  if (!t.assignee) {
    // Sem técnico só é problema na OS em aberto que não está esperando o cliente ou o fornecedor.
    return isOpenTicket(t) && !waiting(t) ? (
      <span className="text-xs font-medium text-amber-700 dark:text-amber-300">Sem técnico</span>
    ) : (
      <span className="text-xs text-ink-subtle">—</span>
    );
  }
  const helpers = t.helpers ?? [];
  const helperNames = helpers.map((h) => h.name).join(", ");
  return (
    <>
      <span className="flex min-w-0 items-center">
        {/* Nome longo não empurra a coluna da OS: corta com reticências (nome inteiro no título). */}
        <span className="truncate" title={t.assignee.name}>
          {t.assignee.name}
        </span>
        {t.assignee.is_active === false ? (
          <span
            className="ml-1.5 shrink-0 rounded-full bg-red-50 px-1.5 py-px text-[11px] font-medium text-red-700 dark:bg-red-500/10 dark:text-red-300"
            title="Técnico desativado: não entra no app. Reatribua a OS."
          >
            inativo
          </span>
        ) : null}
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
    </>
  );
}

/** Cliente e loja (código, nome e cidade). */
export function StoreCell({ t }: { t: TicketListItem }) {
  const customer = t.customer?.name ?? t.requester_name ?? "—";
  const store = storeLabel(t);
  return (
    <>
      <span className="block truncate" title={customer}>
        {customer}
      </span>
      {store ? (
        <span className="block truncate text-xs text-ink-subtle" title={store}>
          {store}
        </span>
      ) : null}
    </>
  );
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
          <span className="max-w-[6rem] truncate text-xs text-ink-muted max-2xl:sr-only" title={owner.name}>
            {mine ? "Você" : owner.name.split(" ")[0]}
          </span>
        </>
      ) : (
        <span className="text-xs text-ink-subtle">—</span>
      )}
      {isOpenTicket(t) && !mine ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClaim(t);
          }}
          disabled={claiming}
          className="-my-1 shrink-0 rounded-md p-1.5 text-ink-subtle transition-colors hover:bg-surface-3 hover:text-brand-ink focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none disabled:opacity-40"
          aria-label={owner ? `Assumir ${t.code} (hoje com ${owner.name})` : `Assumir ${t.code}`}
          title={owner ? `Assumir: a OS sai da fila de ${owner.name} e vai para a sua` : "Assumir: a OS vai para a sua fila"}
        >
          <Hand aria-hidden className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/** Prazo do SLA: cor só para o problema (em risco, violado); no prazo, cumprido e pausado ficam neutros. */
export function SlaCell({ t, now, compact }: { t: TicketListItem; now: number; compact: boolean }) {
  const open = isOpenTicket(t);
  const status = t.sla_status;
  const arrivalLate = Boolean(t.arrival_due_at && new Date(t.arrival_due_at).getTime() < now);
  return (
    <div className="flex flex-col items-start gap-1">
      {status === "breached" || status === "at_risk" ? (
        <SlaBadge status={status} />
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
          {status === "paused" ? <Pause aria-hidden className="size-3" /> : null}
          {SLA_STATUS[status].label}
        </span>
      )}
      {status === "paused" ? null : <SlaCountdown ticket={t} />}
      {/* Prazo de chegada à loja; na lista compacta, só quando já passou. */}
      {open && !t.arrived_at && (!compact || arrivalLate) ? <ArrivalChip ticket={t} compact /> : null}
      {!compact && t.status === "in_progress" ? <OnsiteBar ticket={t} className="mt-0.5" /> : null}
    </div>
  );
}

/** A OS como cartão, no lugar da tabela em tela estreita (celular): o toque abre a OS no painel. */
export function TicketCard({ t, now }: { t: TicketListItem; now: number }) {
  const store = storeLabel(t);
  const late = isOpenTicket(t) ? lateMinutes(t, now) : null;
  return (
    <TicketLink ticketId={t.id} className="flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-[var(--row-hover)]">
      <span className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[11px] text-ink-subtle">
          {t.code}
          {t.client_reference ? ` · ${t.client_reference}` : ""}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <StatusBadge status={t.status} />
          <PriorityBadge priority={t.priority} compact />
        </span>
      </span>
      <span className="line-clamp-2 text-sm font-semibold text-ink">{t.title}</span>
      <span className="truncate text-xs text-ink-muted">{[t.customer?.name, store].filter(Boolean).join(" · ") || "Sem loja"}</span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
        {t.scheduled_start ? (
          <span className="tabular-nums">{dayTimeLabel(t.scheduled_start, now)}</span>
        ) : (
          <span className="text-ink-subtle">{isOpenTicket(t) ? "Sem agenda" : "—"}</span>
        )}
        {late !== null ? <span className="font-semibold text-red-700 dark:text-red-300">atrasada há {formatMinutes(Math.max(1, late))}</span> : null}
        <span aria-hidden>·</span>
        {t.assignee ? (
          <span className="truncate">{t.assignee.name}</span>
        ) : isOpenTicket(t) && !waiting(t) ? (
          <span className="font-medium text-amber-700 dark:text-amber-300">Sem técnico</span>
        ) : (
          <span className="text-ink-subtle">sem técnico</span>
        )}
      </span>
      {t.sla_status === "breached" || t.sla_status === "at_risk" ? (
        <span className="flex flex-wrap items-center gap-2">
          <SlaBadge status={t.sla_status} />
          <SlaCountdown ticket={t} />
        </span>
      ) : null}
    </TicketLink>
  );
}
