"use client";

import { type UseQueryResult, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  AlarmClock,
  Building2,
  CalendarClock,
  CheckCircle2,
  Coffee,
  HardHat,
  Inbox,
  KeyRound,
  Navigation,
  Plus,
  TriangleAlert,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { PriorityBadge, SlaCountdown, StatusBadge } from "@/components/badges";
import { CountUp } from "@/components/motion";
import { NoAccess } from "@/components/NoAccess";
import {
  isOpenStatus,
  isUuid,
  mayHaveGroupText,
  OPERATION_TZ,
  operationDay,
  replaceSearch,
  revealSection,
  useClaim,
  useSearchChange,
} from "@/components/operacao/hooks";
import { CopyNowButton } from "@/components/operacao/CopyNowButton";
import { ClaimButton, InactiveChip, LiveStatus, RefreshFailed } from "@/components/operacao/status";
import { GrantAccessDialog } from "@/components/technicians/GrantAccessDialog";
import { ArrivalChip, OnsiteBar } from "@/components/ticket/FieldClock";
import { MessagesButton } from "@/components/ticket/MessagesPanel";
import { QuickEditButton } from "@/components/ticket/QuickEditButton";
import { TicketLink } from "@/components/ticket/TicketLink";
import {
  Button,
  buttonClassName,
  Card,
  CardHeader,
  EmptyState,
  ErrorBox,
  LoadingBlock,
  PageHeader,
  SectionTitle,
  Skeleton,
} from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatTime, initials } from "@/lib/format";
import { forbiddenCode, useCan, useQueueScope } from "@/lib/permissions";
import type {
  MyQueue,
  Page,
  QueueItem,
  QueueReason,
  QueueScope,
  QueueSection,
  QueuesOut,
  TicketListItem,
  TicketStatus,
  UserRef,
  UUID,
} from "@/lib/types";

/** As OS sem analista responsável (na URL: ?analista=sem). */
const UNOWNED = "sem";
const UNOWNED_LIMIT = 100;

const SECTIONS: { key: QueueSection; title: string; hint: string }[] = [
  { key: "attention", title: "Precisa de atenção", hint: "Prazo estourando, sem técnico, atrasada para começar ou improdutiva" },
  { key: "in_field", title: "Em campo agora", hint: "Técnico a caminho ou atendendo" },
  { key: "today", title: "Agenda de hoje", hint: "Visitas marcadas para hoje, pela hora" },
  { key: "waiting", title: "Aguardando", hint: "Pendente do cliente ou de fornecedor" },
  { key: "unscheduled", title: "Sem agenda", hint: "Abertas, ainda sem visita marcada" },
  { key: "upcoming", title: "Próximos dias", hint: "Já agendadas" },
  { key: "done", title: "Concluídas hoje", hint: "Resolvidas hoje" },
];

/** Antes de começar a visita: só aí o horário vencido é atraso (pausada ou em campo não conta). */
const NOT_STARTED: TicketStatus[] = ["new", "triage", "assigned", "scheduled", "reopened"];
/** Atraso só 30 min depois do horário, como o "Atrasada" da API e a Início. */
const LATE_AFTER_MS = 30 * 60_000;

/** Linha da fila: a OS da fila (com seção e motivos) ou uma OS da lista "sem analista". */
type Row = TicketListItem & Partial<Pick<QueueItem, "section" | "reasons">>;
type Claim = { busy: boolean; onClaim: () => void } | null;
/** "Liberar acesso" do técnico sem acesso ao app (só com Técnicos: Editar); null sem o acesso. */
type Grant = ((technician: UserRef) => void) | null;

const REASON_TONE: Record<QueueReason["tone"], string> = {
  danger: "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25",
  warning: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25",
  info: "bg-brand-soft text-brand-ink ring-brand/20",
};

function greeting(): string {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: OPERATION_TZ }).format(new Date()));
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

function longToday(): string {
  const text = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", timeZone: OPERATION_TZ }).format(
    new Date(),
  );
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function shortDay(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: OPERATION_TZ })
    .format(new Date(value))
    .replace(".", "");
}

/**
 * Indicador do topo. Com valor, leva ao que conta (rola até a seção ou abre a lista); com zero, é só
 * o número, sem cara de botão. Vermelho só quando sinaliza problema.
 */
function Kpi({
  label,
  value,
  icon: Icon,
  alert,
  index,
  onClick,
  href,
  note,
}: {
  label: string;
  /** null enquanto carrega. */
  value: number | null;
  icon: React.ComponentType<{ className?: string }>;
  alert?: boolean;
  index: number;
  onClick?: () => void;
  href?: string;
  /** Linha a mais embaixo do rótulo (ex.: "+2 que você executa"). */
  note?: string | null;
}) {
  const interactive = value !== null && value > 0 && Boolean(onClick || href);
  const className = clsx(
    "group flex items-center gap-3 rounded-xl border bg-surface p-4 text-left shadow-elev-1",
    interactive && "transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-elev-2",
    alert ? "border-red-200 dark:border-red-500/30" : "border-line",
  );
  const style = { ["--i" as string]: index };
  const body = (
    <>
      <span
        className={clsx(
          "flex size-10 shrink-0 items-center justify-center rounded-xl",
          alert ? "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400" : "bg-surface-2 text-ink-muted",
        )}
      >
        <Icon className="size-5" />
      </span>
      <span className="min-w-0">
        {value === null ? (
          <Skeleton className="h-6 w-10" />
        ) : (
          <CountUp
            value={value}
            duration={300}
            className={clsx(
              "block text-2xl leading-none font-semibold tracking-tight",
              alert ? "text-red-600 dark:text-red-400" : "text-ink",
            )}
          />
        )}
        <span className="mt-1 block text-xs leading-snug font-medium text-ink-muted">{label}</span>
        {note ? <span className="mt-0.5 block text-[11px] leading-snug text-ink-muted">{note}</span> : null}
      </span>
    </>
  );
  if (interactive && href) {
    return (
      <Link href={href} className={className} style={style}>
        {body}
      </Link>
    );
  }
  if (interactive && onClick) {
    return (
      <button type="button" onClick={onClick} className={className} style={style}>
        {body}
      </button>
    );
  }
  return (
    <div className={className} style={style}>
      {body}
    </div>
  );
}

function CountPill({ value, danger }: { value: number; danger?: boolean }) {
  return (
    <span
      className={clsx(
        "rounded-full px-1.5 text-[11px] leading-[18px] font-semibold tabular-nums",
        danger && value > 0 ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300" : "bg-surface-2 text-ink-muted",
      )}
    >
      {value}
    </span>
  );
}

/** Motivos de atenção. "Justificar SLA" abre a OS, onde o cartão de SLA pede o motivo. */
function Reasons({ ticketId, reasons }: { ticketId: UUID; reasons: QueueReason[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {reasons.map((r) => {
        const className = clsx("rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset", REASON_TONE[r.tone]);
        return r.code === "violation_pending" ? (
          <TicketLink
            key={r.code}
            ticketId={ticketId}
            className={clsx(className, "underline-offset-2 hover:underline")}
            title="Abrir a OS para informar o motivo da violação"
          >
            {r.label}
          </TicketLink>
        ) : (
          <span key={r.code} className={className}>
            {r.label}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Técnico da visita (quem vai junto como +N). Sem os motivos da fila, avisa do técnico sem acesso ao app.
 * Com Técnicos: Editar, o técnico sem acesso ganha o "Liberar acesso" (OS em aberto).
 */
function Technician({ item, flagInactive, onGrant }: { item: TicketListItem; flagInactive: boolean; onGrant?: Grant }) {
  const technician = item.assignee && item.assignee.role === "technician" ? item.assignee : null;
  const locked = technician?.is_active === false;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      <HardHat className="size-3.5 shrink-0 text-ink-subtle" />
      {technician ? (
        <span className="truncate">{technician.name}</span>
      ) : (
        <span className="font-medium text-amber-700 dark:text-amber-400">Sem técnico</span>
      )}
      {item.helpers?.length ? (
        <span title={`Vai junto: ${item.helpers.map((h) => h.name).join(", ")}`}>+{item.helpers.length}</span>
      ) : null}
      {flagInactive && locked ? <InactiveChip /> : null}
      {technician && locked && onGrant && isOpenStatus(item.status) ? (
        <button
          type="button"
          onClick={() => onGrant(technician)}
          aria-label={`Liberar o acesso de ${technician.name} ao app`}
          title="Libera o acesso ao app e gera a senha provisória"
          className={clsx(
            "ml-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[11px] font-semibold text-brand-ink ring-1 ring-brand/25 ring-inset",
            "transition-colors hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none",
          )}
        >
          <KeyRound aria-hidden className="size-3" />
          Liberar acesso
        </button>
      ) : null}
    </span>
  );
}

function Actions({
  item,
  claim,
  quickText = false,
  className,
}: {
  item: TicketListItem;
  claim: Claim;
  /** Um clique copia o texto do momento para o grupo (confirmada, a caminho, encerrada...). */
  quickText?: boolean;
  className?: string;
}) {
  return (
    <div className={clsx("flex shrink-0 items-center gap-1 border-l border-line", className)}>
      {quickText && mayHaveGroupText(item) ? (
        <span className="hidden sm:inline-flex">
          <CopyNowButton ticketId={item.id} code={item.code} />
        </span>
      ) : null}
      {claim ? <ClaimButton code={item.code} busy={claim.busy} onClaim={claim.onClaim} /> : null}
      <MessagesButton ticketId={item.id} code={item.code} />
      <QuickEditButton ticketId={item.id} code={item.code} />
    </div>
  );
}

function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={clsx(
        "flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-semibold text-ink-muted",
        className ?? "size-6 text-[10px]",
      )}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

function QueueRow({
  item,
  today,
  claim,
  quickText = false,
  onGrant,
}: {
  item: Row;
  today: string;
  claim: Claim;
  quickText?: boolean;
  onGrant?: Grant;
}) {
  const loc = item.location;
  const place = [item.customer?.name, loc?.name, loc?.city].filter(Boolean).join(" · ");
  const done = item.section === "done" || !isOpenStatus(item.status);
  const inField = item.section === "in_field" || item.status === "en_route" || item.status === "in_progress";
  // Cor só quando sinaliza problema: P1 e P2 aparecem, P3 e P4 não.
  const urgent = item.priority === "critical" || item.priority === "high";
  return (
    <li className="group relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60 sm:px-5">
      <div className="min-w-0 flex-1">
        <TicketLink ticketId={item.id} className="block text-sm font-semibold text-ink hover:text-brand">
          <span className="mr-1.5 font-mono text-xs font-normal text-ink-subtle">{item.code}</span>
          {item.title}
        </TicketLink>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          {/* No celular a coluna da direita some: o status vem para a linha de detalhes. */}
          <span className="sm:hidden">
            <StatusBadge status={item.status} />
          </span>
          {place ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <Building2 className="size-3.5 shrink-0 text-ink-subtle" />
              <span className="truncate">{place}</span>
            </span>
          ) : null}
          <Technician item={item} flagInactive={!item.reasons} onGrant={onGrant} />
          {item.scheduled_start && item.section !== "today" ? (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <CalendarClock className="size-3.5 shrink-0 text-ink-subtle" />
              {/* Fora de hoje (atrasada de ontem, próximos dias), com o dia junto da hora. */}
              {operationDay(item.scheduled_start) === today
                ? formatTime(item.scheduled_start)
                : `${shortDay(item.scheduled_start)} ${formatTime(item.scheduled_start)}`}
            </span>
          ) : null}
          {done && item.resolved_at ? (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <CheckCircle2 className="size-3.5 shrink-0 text-ink-subtle" />
              {/* De outro dia (a fila de outra data), com o dia junto da hora. */}
              Concluída{" "}
              {operationDay(item.resolved_at) === today
                ? formatTime(item.resolved_at)
                : `${shortDay(item.resolved_at)} ${formatTime(item.resolved_at)}`}
            </span>
          ) : null}
        </div>
        {item.reasons?.length ? <Reasons ticketId={item.id} reasons={item.reasons} /> : null}
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-1.5 sm:flex">
        <div className="flex items-center gap-1.5">
          {urgent ? <PriorityBadge priority={item.priority} compact /> : null}
          <StatusBadge status={item.status} />
        </div>
        {done ? null : <SlaCountdown ticket={item} />}
        {!done && !item.arrived_at ? <ArrivalChip ticket={item} compact /> : null}
        {inField ? <OnsiteBar ticket={item} /> : null}
      </div>
      {/* Ações sempre no canto direito, alinhadas em coluna (como "Editar" nas tabelas). */}
      <Actions item={item} claim={claim} quickText={quickText} className="self-center pl-3" />
    </li>
  );
}

/** Agenda do dia como linha do tempo: hora à esquerda, marcador e a OS. */
function TodayTimeline({ items, claimFor }: { items: QueueItem[]; claimFor: (item: TicketListItem) => Claim }) {
  const now = useNow(60_000);
  return (
    <ol className="relative px-4 py-3 sm:px-5">
      {items.map((item) => {
        const start = item.scheduled_start ? new Date(item.scheduled_start).getTime() : null;
        // Atraso só antes de começar e passada a tolerância: a OS já atendida e pausada (aguardando) não
        // está "atrasada".
        const past = start !== null && start + LATE_AFTER_MS < now && NOT_STARTED.includes(item.status) && !item.arrived_at;
        return (
          <li key={item.id} className="group relative flex gap-4 pb-4 last:pb-0">
            <div className="w-12 shrink-0 pt-0.5 text-right">
              <span className={clsx("text-sm font-semibold tabular-nums", past ? "text-red-600 dark:text-red-400" : "text-ink")}>
                {formatTime(item.scheduled_start)}
              </span>
              {item.scheduled_end ? (
                <span className="block text-[11px] text-ink-subtle tabular-nums">{formatTime(item.scheduled_end)}</span>
              ) : null}
            </div>
            <div className="relative flex flex-col items-center">
              <span
                className={clsx(
                  "relative z-10 mt-1.5 size-2.5 rounded-full ring-4 ring-surface",
                  past ? "bg-red-500" : "bg-brand",
                )}
              />
              <span className="absolute top-3 bottom-[-12px] w-px bg-line group-last:hidden" />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-line bg-surface py-2.5 pr-2.5 pl-3.5 transition-[border-color,box-shadow] group-hover:border-line-strong group-hover:shadow-elev-1">
              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-2">
                  <TicketLink ticketId={item.id} className="min-w-0 flex-1 text-sm font-semibold text-ink hover:text-brand">
                    <span className="mr-1.5 font-mono text-xs font-normal text-ink-subtle">{item.code}</span>
                    {item.title}
                  </TicketLink>
                  <StatusBadge status={item.status} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <Building2 className="size-3.5 shrink-0 text-ink-subtle" />
                    <span className="truncate">
                      {[item.customer?.name, item.location?.name, item.location?.city].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </span>
                  <Technician item={item} flagInactive={false} />
                  {past ? (
                    <span className="inline-flex items-center gap-1 font-medium text-red-600 dark:text-red-400">
                      <AlarmClock className="size-3.5" />
                      Ainda não começou
                    </span>
                  ) : null}
                  {!item.arrived_at ? <ArrivalChip ticket={item} compact /> : null}
                </div>
                {item.reasons.length ? <Reasons ticketId={item.id} reasons={item.reasons} /> : null}
              </div>
              <Actions item={item} claim={claimFor(item)} quickText className="self-stretch pl-2.5" />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function AttentionCount({ value }: { value: number }) {
  return (
    <span
      title="Precisam de atenção"
      className={clsx(
        "min-w-6 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold tabular-nums",
        value ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300" : "bg-surface-2 text-ink-muted",
      )}
    >
      {value}
    </span>
  );
}

/**
 * Filas dos analistas (abertas e alertas de cada um) e as OS sem analista. Um clique abre a fila.
 * Com "Somente a própria fila", a API manda só a linha de quem vê (e a "Sem analista", se ela vê).
 * A linha de quem vê ("Você") fica no topo, com o nome da conta no title e no aria-label ("Você" e uma
 * conta chamada "Administrador" podem ser pessoas diferentes). Embaixo, a soma das linhas ("Equipe").
 */
function TeamQueues({
  meId,
  viewing,
  queues,
  scope,
  onPick,
}: {
  meId: UUID;
  /** O id da fila aberta, ou UNOWNED. */
  viewing: string;
  queues: UseQueryResult<QueuesOut>;
  /** Filas que o acesso de quem vê mostra. */
  scope: { scope: QueueScope; unowned: boolean };
  onPick: (id: string) => void;
}) {
  const own = scope.scope === "own";
  // A resposta já vem filtrada; o filtro daqui só cobre a lista guardada de antes de o acesso mudar.
  const listed = (queues.data?.queues ?? []).filter((q) => !own || q.user.id === meId);
  const rows = [...listed.filter((q) => q.user.id === meId), ...listed.filter((q) => q.user.id !== meId)];
  const unowned = own && !scope.unowned ? null : queues.data?.unowned;
  // A soma (TeamQueues.total) só quando há mais de uma linha: com uma, repetiria a própria.
  const total = rows.length + (unowned ? 1 : 0) > 1 ? queues.data?.total : null;
  return (
    <Card>
      <CardHeader title="Filas da equipe" actions={<span className="text-[11px] text-ink-muted">abertas · atenção</span>} />
      {queues.isLoading ? (
        <div className="space-y-3 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
      ) : queues.error && !queues.data ? (
        <div className="p-3">
          <ErrorBox message={errorMessage(queues.error)} onRetry={() => void queues.refetch()} />
        </div>
      ) : (
        <ul className="p-1.5">
          {rows.map((q) => {
            const selected = q.user.id === viewing;
            const me = q.user.id === meId;
            return (
              <li key={q.user.id}>
                <button
                  type="button"
                  onClick={() => onPick(q.user.id)}
                  aria-pressed={selected}
                  aria-label={`${me ? `Sua fila (${q.user.name})` : `Fila de ${q.user.name}`}: ${q.open} abertas, ${q.attention} precisam de atenção, ${q.today} hoje, ${q.in_field} em campo`}
                  title={me ? q.user.name : undefined}
                  className={clsx(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    selected ? "bg-brand-soft" : "hover:bg-surface-2",
                  )}
                >
                  <Avatar name={q.user.name} className="size-7 text-[10px]" />
                  <span className="min-w-0 flex-1">
                    <span className={clsx("block truncate text-[13px] text-ink", selected ? "font-bold" : "font-semibold")}>
                      {me ? "Você" : q.user.name}
                    </span>
                    <span className="block text-[11px] text-ink-muted">
                      {q.today} hoje · {q.in_field} em campo
                    </span>
                  </span>
                  <span className="text-sm font-semibold text-ink tabular-nums" title="Abertas">
                    {q.open}
                  </span>
                  <AttentionCount value={q.attention} />
                </button>
              </li>
            );
          })}
          {unowned ? (
            <li className="mt-1 border-t border-line pt-1">
              <button
                type="button"
                onClick={() => onPick(UNOWNED)}
                aria-pressed={viewing === UNOWNED}
                aria-label={`OS sem analista: ${unowned.open} abertas, ${unowned.attention} precisam de atenção, ${unowned.today} hoje, ${unowned.in_field} em campo`}
                className={clsx(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                  viewing === UNOWNED ? "bg-brand-soft" : "hover:bg-surface-2",
                )}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-ink-muted">
                  <Inbox className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={clsx("block text-[13px] text-ink", viewing === UNOWNED ? "font-bold" : "font-semibold")}>
                    Sem analista
                  </span>
                  <span className="block text-[11px] text-ink-muted">
                    {unowned.today} hoje · {unowned.in_field} em campo
                  </span>
                </span>
                <span className="text-sm font-semibold text-ink tabular-nums" title="Abertas">
                  {unowned.open}
                </span>
                <AttentionCount value={unowned.attention} />
              </button>
            </li>
          ) : null}
          {total ? (
            <li className="mt-1 border-t border-line pt-1">
              <div className="flex items-center gap-2.5 px-2.5 py-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-ink-muted">
                  <Users aria-hidden className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-bold text-ink">{own ? "Total" : "Equipe"}</span>
                  <span className="block text-[11px] text-ink-muted">
                    {total.today} hoje · {total.in_field} em campo
                  </span>
                </span>
                <span className="text-sm font-bold text-ink tabular-nums" title="Abertas">
                  {total.open}
                </span>
                <AttentionCount value={total.attention} />
              </div>
            </li>
          ) : null}
        </ul>
      )}
      {own ? (
        <p className="border-t border-line px-4 py-2.5 text-[11px] text-ink-muted">
          Seu acesso mostra só a sua fila{scope.unowned ? " e as OS sem analista" : ""}.
        </p>
      ) : null}
    </Card>
  );
}

/** A fila aberta guardada na URL: ?analista=<id> ou ?analista=sem; sem o parâmetro, a minha. */
function queueFromUrl(params: URLSearchParams): string | null {
  const value = params.get("analista");
  return value === UNOWNED || isUuid(value) ? value : null;
}

/** Seções candidatas de cada indicador: rola até a primeira que estiver na tela. */
function reveal(keys: QueueSection[]) {
  for (const key of keys) {
    const el = document.getElementById(`fila-${key}`);
    if (el) {
      revealSection(el);
      return;
    }
  }
}

function MyQueueView() {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const allowed = canManageTickets(user?.role);
  // Solicitante não tem fila: vai para os chamados dele.
  useEffect(() => {
    if (user && !allowed) router.replace("/chamados");
  }, [user, allowed, router]);
  // A fila aberta fica na URL: recarregar ou mandar o link mantém.
  const [viewing, setViewing] = useState(() => queueFromUrl(searchParams));
  // A URL mudou com a tela aberta (o link do menu volta para a minha fila, Voltar): mostra o que ela diz.
  const urlChange = useSearchChange();
  if (urlChange) {
    const next = queueFromUrl(urlChange);
    if (next !== viewing) setViewing(next);
  }
  const now = useNow(60_000);
  const meId = user?.id ?? null;
  const unowned = viewing === UNOWNED;
  const mine = !unowned && (!viewing || viewing === meId);
  const ownerId = unowned ? null : mine ? meId : viewing;
  // "Somente a própria fila": a fila de um colega (e a "Sem analista", sem a opção) não abre; a API
  // também recusa (403), então nem pergunta.
  const scope = useQueueScope();
  const ownOnly = scope.scope === "own";
  const outsideScope = ownOnly && ((!mine && !unowned) || (unowned && !scope.unowned));

  const queues = useQuery({
    queryKey: ["tickets", "queues"],
    queryFn: ({ signal }) => api.get<QueuesOut>("/queues", undefined, { signal }),
    staleTime: 30_000,
    enabled: allowed,
  });
  // Sem dados de reserva: ao trocar de fila, a tela não mostra a fila anterior com o nome novo.
  const queue = useQuery({
    queryKey: ["tickets", "my-queue", ownerId],
    queryFn: ({ signal }) => api.get<MyQueue>("/my-queue", mine ? {} : { user_id: ownerId ?? undefined }, { signal }),
    enabled: Boolean(ownerId) && allowed && !outsideScope,
    // "Atrasada" e prazos dependem do relógio: revalida mesmo sem eventos.
    refetchInterval: 60_000,
  });
  const orphans = useQuery({
    queryKey: ["tickets", "unowned-queue"],
    queryFn: ({ signal }) =>
      api.get<Page<TicketListItem>>(
        "/tickets",
        { no_owner: true, open_only: true, order_by: "resolution_due_at", page_size: UNOWNED_LIMIT },
        { signal },
      ),
    enabled: unowned && allowed && !outsideScope,
    refetchInterval: 60_000,
  });
  // O acesso mudou com a tela aberta (a API recusou a fila do colega): a mesma tela amigável.
  const blocked = outsideScope || (!mine && forbiddenCode(queue.error) === "QUEUE_FORBIDDEN");
  const { claim, isClaiming } = useClaim();
  // "Liberar acesso" do técnico sem acesso ao app: com Técnicos: Editar (a API confere de novo). O diálogo
  // fica fora das linhas: liberado o acesso, a fila relê e o motivo some, mas a senha continua na tela.
  const queryClient = useQueryClient();
  const canGrant = useCan("base.technicians", "edit");
  // O atalho para Atividades do dia só com a tela (sem ela, o link levaria a "Sem acesso").
  const canDay = useCan("operation.day");
  const [granting, setGranting] = useState<UserRef | null>(null);
  const onGrant: Grant = canGrant ? setGranting : null;
  const closeGrant = () => {
    setGranting(null);
    void queryClient.invalidateQueries({ queryKey: ["tickets"] });
  };

  const grouped = useMemo(() => {
    const map = new Map<QueueSection, QueueItem[]>();
    for (const item of queue.data?.items ?? []) {
      const list = map.get(item.section) ?? [];
      list.push(item);
      map.set(item.section, list);
    }
    return map;
  }, [queue.data]);

  if (user && !allowed) return null;

  const pick = (next: string | null) => {
    const value = next === meId ? null : next;
    setViewing(value);
    replaceSearch({ analista: value });
  };
  const claimFor = (item: TicketListItem): Claim =>
    meId && isOpenStatus(item.status) && item.owner?.id !== meId
      ? { busy: isClaiming(item.id), onClaim: () => claim(item) }
      : null;
  const today = queue.data?.date ?? operationDay(now);
  const colleague =
    !mine && !unowned
      ? (queues.data?.queues.find((q) => q.user.id === viewing)?.user ??
        (queue.data?.user.id === viewing ? queue.data.user : null))
      : null;
  const active = unowned
    ? { updatedAt: orphans.dataUpdatedAt, error: orphans.error, errorAt: orphans.errorUpdatedAt, hasData: Boolean(orphans.data), fetching: orphans.isFetching }
    : { updatedAt: queue.dataUpdatedAt, error: queue.error, errorAt: queue.errorUpdatedAt, hasData: Boolean(queue.data), fetching: queue.isFetching };
  const refresh = () => {
    void (unowned ? orphans.refetch() : queue.refetch());
    void queues.refetch();
  };
  const live = <LiveStatus updatedAt={active.updatedAt} every="a cada minuto" onRefresh={refresh} refreshing={active.fetching} />;
  const title = mine
    ? `${greeting()}, ${(user?.name ?? "").split(" ")[0]}`
    : unowned
      ? "OS sem analista"
      : colleague
        ? `Fila de ${colleague.name}`
        : blocked
          ? "Fila de outro analista"
          : "Carregando...";
  const description = blocked ? undefined : mine ? (
    <>Suas OS, pelo que pede ação primeiro · {live}</>
  ) : (
    <>Use Puxar para trazer uma OS para a sua fila · {live}</>
  );

  const orphanItems = orphans.data?.items ?? [];
  const main = blocked ? (
    <Card>
      <NoAccess kind="queue" as="h2" title={unowned ? "OS sem analista" : "Fila de outro analista"} />
    </Card>
  ) : active.error && !active.hasData ? (
    <ErrorBox message={errorMessage(active.error)} onRetry={refresh} />
  ) : unowned ? (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            OS sem analista
            {orphans.data ? <CountPill value={orphans.data.total} /> : null}
          </span>
        }
        description="Abertas e sem analista responsável, o prazo de solução mais perto primeiro"
        actions={
          <Link href="/chamados?no_owner=true" className="text-xs font-medium text-ink-muted hover:text-brand">
            Ver em Chamados
          </Link>
        }
      />
      {orphans.isLoading ? (
        <LoadingBlock rows={4} label="Carregando as OS sem analista..." />
      ) : orphanItems.length === 0 ? (
        <EmptyState icon={<Coffee />} title="Nenhuma OS sem analista" description="Todas as OS abertas têm um analista responsável." />
      ) : (
        <ul className="divide-y divide-line">
          {orphanItems.map((item) => (
            <QueueRow key={item.id} item={item} today={today} claim={claimFor(item)} onGrant={onGrant} />
          ))}
        </ul>
      )}
      {orphans.data && orphans.data.total > orphanItems.length ? (
        <p className="border-t border-line px-5 py-2.5 text-xs text-ink-muted">
          Mostrando {orphanItems.length} de {orphans.data.total}.{" "}
          <Link href="/chamados?no_owner=true" className="font-semibold text-brand-ink underline-offset-2 hover:underline">
            Ver todas em Chamados
          </Link>
        </p>
      ) : null}
    </Card>
  ) : !queue.data ? (
    <Card>
      <LoadingBlock rows={4} label="Carregando a fila..." />
    </Card>
  ) : queue.data.items.length === 0 ? (
    <Card>
      <EmptyState
        icon={<Coffee />}
        title="Fila zerada"
        description={
          mine
            ? "Nenhuma OS aberta com você. Novas OS atribuídas a você aparecem aqui na hora."
            : `Nenhuma OS aberta na fila de ${colleague?.name ?? "quem você escolheu"}.`
        }
        action={
          mine && (!ownOnly || scope.unowned) ? (
            <Button onClick={() => pick(UNOWNED)}>
              <Inbox className="size-4" />
              Ver OS sem analista
            </Button>
          ) : null
        }
      />
    </Card>
  ) : (
    SECTIONS.map((section) => {
      const items = grouped.get(section.key) ?? [];
      if (!items.length) return null;
      return (
        // O id fica no bloco que rola (com a margem da barra do topo) e recebe o foco ao chegar.
        <section key={section.key} id={`fila-${section.key}`} tabIndex={-1} aria-label={section.title} className="scroll-mt-20 rounded-xl">
          <Card className="animate-enter overflow-hidden">
            <CardHeader
              title={
                <span className="inline-flex items-center gap-2">
                  {section.title}
                  <CountPill value={items.length} danger={section.key === "attention"} />
                </span>
              }
              description={section.hint}
              actions={
                section.key === "today" && canDay ? (
                  <Link href="/dia" className="text-xs font-medium text-ink-muted hover:text-brand">
                    Atividades do dia
                  </Link>
                ) : null
              }
            />
            {section.key === "today" ? (
              <TodayTimeline items={items} claimFor={claimFor} />
            ) : (
              <ul className="divide-y divide-line">
                {items.map((item) => (
                  <QueueRow key={item.id} item={item} today={today} claim={claimFor(item)} onGrant={onGrant} quickText />
                ))}
              </ul>
            )}
          </Card>
        </section>
      );
    })
  );
  // Fila maior que a lista (500): a lista fica com as de prazo mais apertado; os números contam todas.
  const cut = queue.data?.truncated && !unowned && !blocked ? queue.data : null;
  const queueHref = ownerId ? `/chamados?owner_id=${ownerId}&open_only=true` : undefined;
  const executing = queue.data?.executing_only ?? 0;
  const counts = queue.data && !unowned ? queue.data.counts : null;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        eyebrow={longToday()}
        title={title}
        description={description}
        actions={
          <>
            {!mine ? (
              <Button variant="ghost" onClick={() => pick(null)}>
                Voltar para a minha fila
              </Button>
            ) : null}
            <Link href="/chamados/novo" className={buttonClassName("primary")}>
              <Plus className="size-4" />
              Nova OS
            </Link>
          </>
        }
      />

      {active.error && active.hasData && !blocked ? (
        <RefreshFailed at={active.errorAt} onRetry={refresh} retrying={active.fetching} className="mb-4" />
      ) : null}

      {unowned || blocked || (active.error && !active.hasData) ? null : (
        // Os cartões contam a fila aberta na tela (a sua ou a do colega), pelo analista responsável: o mesmo
        // número da linha dela em "Filas da equipe".
        <section aria-labelledby="fila-numeros" className="mb-6">
          <SectionTitle
            as="h2"
            wrap
            className="mb-2"
            aside={<span className="text-[11px] text-ink-muted">Pelo analista responsável</span>}
          >
            <span id="fila-numeros">{mine ? "Sua fila" : `Fila de ${colleague?.name ?? "outro analista"}`}</span>
          </SectionTitle>
          <div className="stagger grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Kpi
              index={0}
              label="Na fila"
              value={counts?.open ?? null}
              icon={Inbox}
              href={queueHref}
              note={
                executing > 0
                  ? `+${executing} que ${mine ? "você executa" : `${(colleague?.name ?? "o analista").split(" ")[0]} executa`}`
                  : null
              }
            />
            <Kpi
              index={1}
              label="Precisam de atenção"
              value={counts?.attention ?? null}
              icon={TriangleAlert}
              alert={(counts?.attention ?? 0) > 0}
              onClick={() => reveal(["attention", "in_field"])}
            />
            <Kpi
              index={2}
              label="Agendadas hoje"
              value={counts?.today ?? null}
              icon={CalendarClock}
              onClick={() => reveal(["today", "attention", "in_field"])}
            />
            <Kpi
              index={3}
              label="Em campo agora"
              value={counts?.in_field ?? null}
              icon={Navigation}
              onClick={() => reveal(["in_field"])}
            />
            <Kpi
              index={4}
              label="Concluídas hoje"
              value={counts?.done ?? null}
              icon={CheckCircle2}
              onClick={() => reveal(["done"])}
            />
          </div>
        </section>
      )}

      {/* grid-cols-1 (minmax(0, 1fr)): sem ela, a coluna única cresce até o texto que não quebra (cliente e
          loja de uma linha) e a página rola de lado no celular. */}
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-5">
          {cut ? (
            <p className="rounded-xl border border-line bg-surface px-4 py-2.5 text-xs text-ink-muted shadow-elev-1">
              Mostrando {cut.items.length} de {cut.total ?? cut.items.length} OS: as em aberto de prazo mais apertado primeiro.
              {queueHref ? (
                <>
                  {" "}
                  <Link href={queueHref} className="font-semibold text-brand-ink underline-offset-2 hover:underline">
                    Ver todas em Chamados
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}
          {main}
        </div>

        <aside className="flex flex-col gap-4 xl:sticky xl:top-20">
          {meId ? <TeamQueues meId={meId} viewing={viewing ?? meId} queues={queues} scope={scope} onPick={pick} /> : null}
          <Card className="p-4">
            <SectionTitle>Como a fila se organiza</SectionTitle>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              Entram na fila as OS em que o analista é o responsável ou o executor. Os números do topo contam as em que ele
              é o responsável, como a linha dele em Filas da equipe. Primeiro o que precisa de ação (prazo, técnico, atraso
              de mais de 30 min, OS parada em campo há mais de 12 h), depois o que está em campo, a agenda de hoje, o que
              aguarda, o que está sem agenda, os próximos dias e as concluídas hoje.
            </p>
          </Card>
        </aside>
      </div>
      {granting && canGrant ? <GrantAccessDialog technician={granting} onClose={closeGrant} /> : null}
    </div>
  );
}

export default function MyQueuePage() {
  // useSearchParams pede um Suspense em volta.
  return (
    <Suspense fallback={<LoadingBlock />}>
      <MyQueueView />
    </Suspense>
  );
}
