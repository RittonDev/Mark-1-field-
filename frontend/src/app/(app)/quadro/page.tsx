"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CalendarClock, Loader2, MapPin, Search, UserRound, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { nextDue, PriorityBadge, SlaBadge } from "@/components/badges";
import { fetchTicket, useActiveTechnicians } from "@/components/operacao/hooks";
import { InactiveChip, RefreshFailed } from "@/components/operacao/status";
import { useToast } from "@/components/Toaster";
import { TicketLink } from "@/components/ticket/TicketLink";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import { TransitionDialog } from "@/components/ticket/TransitionDialog";
import { Button, Checkbox, Dialog, ErrorBox, Input, PageHeader, Select, Skeleton } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage, type Query } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  canManageTickets,
  FINAL_STATUSES,
  PRIORITY,
  SELF_ASSIGN_ROLES,
  STATUS,
  STATUS_ORDER,
  TRANSITION_ACTION,
  TRANSITIONS,
} from "@/lib/constants";
import { formatShort } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useCustomers, useTeams } from "@/lib/queries";
import type { Page, TicketDetail, TicketListItem, TicketStatus, User } from "@/lib/types";
import { allowedTargets } from "@/lib/workflow";

const OPEN_COLUMNS = STATUS_ORDER.filter((s) => !FINAL_STATUSES.includes(s));
/** As colunas em aberto vêm numa leitura só (o teto da API por página). */
const OPEN_LIMIT = 500;
/** Fechadas e canceladas são milhares: cada coluna mostra só as mais recentes. */
const FINAL_LIMIT = 30;
/** Colunas da visita: os cartões seguem a hora marcada. */
const VISIT_COLUMNS: TicketStatus[] = ["assigned", "scheduled", "en_route"];
/** Visita que já devia ter começado: atribuída ou agendada com o horário vencido. */
const WAITING_VISIT: TicketStatus[] = ["assigned", "scheduled"];
/** Concluir exige os formulários obrigatórios e a assinatura (a mesma regra da API). */
const CLOSING: TicketStatus[] = ["resolved", "closed"];
/** Valor do filtro de técnico para as OS sem técnico. */
const NO_TECH = "none";

type Move = { ticket: TicketDetail; to: TicketStatus };

const timeOf = (value: string | null | undefined) => (value ? new Date(value).getTime() : Number.POSITIVE_INFINITY);
const rankOf = (t: TicketListItem) => PRIORITY[t.priority].rank;

/** O mais urgente em cima: nas colunas da visita, pela hora marcada; nas outras, prioridade e prazo. */
function sortColumn(status: TicketStatus, items: TicketListItem[]): TicketListItem[] {
  const visit = VISIT_COLUMNS.includes(status);
  return [...items].sort((a, b) =>
    visit
      ? timeOf(a.scheduled_start) - timeOf(b.scheduled_start) || rankOf(a) - rankOf(b) || b.number - a.number
      : rankOf(a) - rankOf(b) || timeOf(nextDue(a)?.at) - timeOf(nextDue(b)?.at) || b.number - a.number,
  );
}

/**
 * Para onde o cartão pode ir. Além das transições permitidas, a gestão vê as colunas que pedem
 * técnico mesmo numa OS sem técnico: ao soltar, o quadro explica e leva para a escolha do técnico
 * (sem isso a coluna só não acendia, ou o analista virava o executor sem perceber).
 */
function targetsFor(user: User | null, ticket: TicketListItem): TicketStatus[] {
  const allowed = allowedTargets(user, ticket);
  if (!user || !canManageTickets(user.role) || ticket.assignee) return allowed;
  return TRANSITIONS[ticket.status].filter((to) => allowed.includes(to) || STATUS[to].requiresAssignee);
}

/** O que ainda impede concluir a OS (a API recusaria depois de digitar a solução). */
function closingBlocker(t: TicketDetail): string | null {
  const forms = t.forms.filter((f) => f.required && f.status !== "completed").map((f) => f.name);
  if (forms.length) return `Conclua o formulário obrigatório antes: ${forms.join(", ")}`;
  if (t.signature_required && !t.signed_at) return "Colete a assinatura do responsável no local antes de concluir a OS";
  return null;
}

/** Fechadas ou canceladas: as mais recentes daquele status, com o total para o cabeçalho. */
function useFinalColumn(status: TicketStatus, filters: Query, enabled: boolean) {
  return useQuery({
    queryKey: ["tickets", "board", "final", status, filters],
    queryFn: () =>
      api.get<Page<TicketListItem>>("/tickets", {
        ...filters,
        status: [status],
        order_by: "-updated_at",
        page_size: FINAL_LIMIT,
      }),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

/** Mudar o status sem arrastar (teclado, tablet e celular), com o mesmo fluxo do soltar. */
function MoveSelect({
  code,
  targets,
  disabled,
  onMove,
}: {
  code: string;
  targets: TicketStatus[];
  disabled: boolean;
  onMove: (to: TicketStatus) => void;
}) {
  return (
    <select
      aria-label={`Mudar o status da ${code}`}
      value=""
      disabled={disabled}
      onChange={(e) => {
        const to = e.target.value as TicketStatus;
        if (to) onMove(to);
      }}
      className={clsx(
        "h-7 max-w-[8.5rem] min-w-0 shrink-0 cursor-pointer truncate rounded-md border border-line bg-surface pr-6 pl-2 text-xs font-medium text-ink-muted",
        "transition-colors hover:border-line-strong hover:text-ink focus:border-brand focus:ring-2 focus:ring-brand/20 focus:outline-none",
        "disabled:cursor-default disabled:opacity-60",
      )}
    >
      <option value="" disabled hidden>
        Mudar status
      </option>
      {targets.map((to) => (
        <option key={to} value={to}>
          {TRANSITION_ACTION[to]}
        </option>
      ))}
    </select>
  );
}

function BoardCard({
  ticket,
  now,
  targets,
  busy,
  locked,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  ticket: TicketListItem;
  now: number;
  targets: TicketStatus[];
  /** Lendo a OS para abrir a mudança de status. */
  busy: boolean;
  /** Outra OS está sendo preparada: espera para não abrir dois diálogos. */
  locked: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (to: TicketStatus) => void;
}) {
  const place = [ticket.customer?.name, ticket.location?.name].filter(Boolean).join(" · ");
  const late = WAITING_VISIT.includes(ticket.status) && timeOf(ticket.scheduled_start) < now;
  // Cor só para o que é problema: SLA em risco ou violado e prioridade alta ou crítica.
  const slaProblem = ticket.sla_status === "at_risk" || ticket.sla_status === "breached";
  const urgent = ticket.priority === "critical" || ticket.priority === "high";
  const canDrag = targets.length > 0 && !busy && !locked;
  return (
    <article
      draggable={canDrag}
      aria-busy={busy || undefined}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", ticket.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={clsx(
        "rounded-lg border border-line bg-surface p-3 shadow-elev-1 transition-[opacity,border-color] duration-150 hover:border-line-strong",
        canDrag ? "cursor-grab active:cursor-grabbing" : "cursor-default",
        (dragging || busy) && "opacity-50",
      )}
    >
      <div className="mb-1 flex min-h-5 items-center justify-between gap-2">
        <span className="font-mono text-xs text-ink-muted">{ticket.code}</span>
        <span className="flex shrink-0 items-center gap-1">
          {slaProblem ? <SlaBadge status={ticket.sla_status} /> : null}
          {urgent ? <PriorityBadge priority={ticket.priority} compact /> : null}
          {busy ? <Loader2 className="size-3.5 animate-spin text-ink-muted" aria-label="Abrindo a OS" /> : null}
        </span>
      </div>
      <TicketLink ticketId={ticket.id} className="line-clamp-2 text-sm font-semibold text-ink hover:text-brand">
        {ticket.title}
      </TicketLink>
      {place ? (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-ink-muted">
          <MapPin className="size-3 shrink-0" />
          <span className="truncate">{place}</span>
        </p>
      ) : null}
      {ticket.scheduled_start ? (
        <p
          className={clsx(
            "mt-1 flex items-center gap-1 text-xs tabular-nums",
            late ? "font-semibold text-red-700 dark:text-red-300" : "text-ink-muted",
          )}
        >
          <CalendarClock className="size-3 shrink-0" />
          {formatShort(ticket.scheduled_start)}
          {late ? " · Atrasada" : null}
        </p>
      ) : null}
      <div className="mt-2.5 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <span
            className={clsx(
              "flex min-w-0 items-center gap-1 text-xs",
              ticket.assignee ? "text-ink" : "font-medium text-amber-700 dark:text-amber-400",
            )}
            title={ticket.assignee ? undefined : "Sem técnico: defina o técnico na OS para agendar ou iniciar"}
          >
            <UserRound className="size-3 shrink-0" />
            <span className="truncate">{ticket.assignee?.name ?? "Sem técnico"}</span>
          </span>
          {ticket.assignee?.is_active === false ? <InactiveChip className="mt-1" /> : null}
        </div>
        {targets.length ? (
          <MoveSelect code={ticket.code} targets={targets} disabled={busy || locked} onMove={onMove} />
        ) : null}
      </div>
    </article>
  );
}

function ColumnSkeleton() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-lg border border-line bg-surface p-3" style={{ opacity: 1 - i * 0.25 }}>
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-2 h-3.5 w-11/12" />
          <Skeleton className="mt-1.5 h-3 w-2/3" />
        </div>
      ))}
    </>
  );
}

export default function BoardPage() {
  const { user } = useAuth();
  const router = useRouter();
  const panel = useTicketPanel();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Atrasos dependem do relógio: um só relógio para todos os cartões.
  const now = useNow(60_000);
  const teams = useTeams();
  const customers = useCustomers();
  const technicians = useActiveTechnicians();
  const [showFinal, setShowFinal] = useState(false);
  const [mine, setMine] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [tech, setTech] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [dragging, setDragging] = useState<TicketListItem | null>(null);
  const [overColumn, setOverColumn] = useState<TicketStatus | null>(null);
  // OS sendo lida antes de abrir a mudança de status (o cartão mostra o carregamento).
  const [preparing, setPreparing] = useState<string | null>(null);
  const [noTech, setNoTech] = useState<Move | null>(null);
  const [pending, setPending] = useState<Move | null>(null);

  const filters: Query = {
    mine,
    team_id: teamId || undefined,
    assignee_id: tech && tech !== NO_TECH ? tech : undefined,
    unassigned: tech === NO_TECH || undefined,
    customer_id: customerId || undefined,
    q: q || undefined,
  };
  const open = useQuery({
    queryKey: ["tickets", "board", "open", filters],
    queryFn: () =>
      api.get<Page<TicketListItem>>("/tickets", {
        ...filters,
        status: OPEN_COLUMNS,
        order_by: "priority",
        page_size: OPEN_LIMIT,
      }),
    placeholderData: keepPreviousData,
    // Selos de SLA e atrasos mudam com o relógio: relê mesmo sem eventos (e com o tempo real caído).
    refetchInterval: 60_000,
  });
  const closed = useFinalColumn("closed", filters, showFinal);
  const cancelled = useFinalColumn("cancelled", filters, showFinal);

  const grouped = useMemo(() => {
    const map = new Map<TicketStatus, TicketListItem[]>();
    for (const t of open.data?.items ?? []) {
      const list = map.get(t.status) ?? [];
      list.push(t);
      map.set(t.status, list);
    }
    for (const [status, list] of map) map.set(status, sortColumn(status, list));
    return map;
  }, [open.data]);

  const columns = showFinal ? STATUS_ORDER : OPEN_COLUMNS;
  const dropTargets = dragging ? targetsFor(user, dragging) : [];
  const hasFilters = Boolean(mine || teamId || tech || customerId || search);
  const truncated = open.data && open.data.total > open.data.items.length ? open.data : null;
  const openTicket = (id: string) => (panel ? panel.open(id) : router.push(`/chamados/${id}`));

  const clearFilters = () => {
    setMine(false);
    setTeamId("");
    setTech("");
    setCustomerId("");
    setSearch("");
  };

  /**
   * Mesmo caminho do editor da OS: lê a OS agora (versão, formulários, transições) e só então abre o
   * diálogo, que pede o que o destino exige (agenda, solução, motivo do SLA, motivo).
   */
  async function move(card: TicketListItem, to: TicketStatus, staleTime = 0) {
    if (preparing) return;
    setPreparing(card.id);
    try {
      const detail = await fetchTicket(queryClient, card.id, staleTime);
      if (!TRANSITIONS[detail.status].includes(to)) {
        toast({
          title: `${detail.code} não pode ir para ${STATUS[to].label}`,
          description: `Ela está em ${STATUS[detail.status].label} agora. O quadro foi atualizado.`,
          tone: "error",
        });
        void queryClient.invalidateQueries({ queryKey: ["tickets"] });
        return;
      }
      if (STATUS[to].requiresAssignee && !detail.assignee) {
        setNoTech({ ticket: detail, to });
        return;
      }
      if (!detail.allowed_transitions.includes(to)) {
        toast({ title: `Você não pode levar a ${detail.code} para ${STATUS[to].label}`, tone: "error" });
        return;
      }
      if (CLOSING.includes(to) && !CLOSING.includes(detail.status)) {
        const blocker = closingBlocker(detail);
        if (blocker) {
          toast({ title: blocker, description: "A OS abriu ao lado para concluir o que falta.", tone: "error" });
          openTicket(detail.id);
          return;
        }
      }
      setPending({ ticket: detail, to });
    } catch (error) {
      toast({ title: `Não foi possível abrir a ${card.code}`, description: errorMessage(error), tone: "error" });
    } finally {
      setPreparing(null);
    }
  }

  const endDrag = () => {
    setDragging(null);
    setOverColumn(null);
  };
  const selfAssign = Boolean(
    noTech && user && SELF_ASSIGN_ROLES.includes(user.role) && noTech.ticket.allowed_transitions.includes(noTech.to),
  );

  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col">
      <PageHeader
        title="Quadro de atendimento"
        description="Arraste o cartão ou use Mudar status: só as colunas permitidas aceitam a OS. Em cada coluna, o mais urgente fica em cima."
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-60">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nº, título ou chamado do cliente"
            aria-label="Buscar OS"
            className="pl-9"
          />
        </div>
        <Select value={tech} onChange={(e) => setTech(e.target.value)} aria-label="Técnico" className="w-full sm:w-48">
          <option value="">Todos os técnicos</option>
          <option value={NO_TECH}>Sem técnico</option>
          {technicians.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="Cliente" className="w-full sm:w-48">
          <option value="">Todos os clientes</option>
          {customers.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Grupo" className="w-full sm:w-44">
          <option value="">Todos os grupos</option>
          {teams.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Checkbox label="Minhas OS" checked={mine} onChange={setMine} />
        <Checkbox label="Fechadas e canceladas" checked={showFinal} onChange={setShowFinal} />
        {hasFilters ? (
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            <X className="size-3.5" />
            Limpar filtros
          </Button>
        ) : null}
        <span className="ml-auto text-xs text-ink-muted" aria-live="polite">
          {open.isFetching && !open.isLoading ? "Atualizando..." : ""}
        </span>
      </div>

      {open.error && open.data ? (
        <RefreshFailed
          at={open.errorUpdatedAt}
          onRetry={() => void open.refetch()}
          retrying={open.isFetching}
          className="mb-3"
        />
      ) : null}
      {truncated ? (
        <p
          role="status"
          className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
        >
          Mostrando {truncated.items.length} de {truncated.total} OS em aberto, as de maior prioridade. Use os filtros para
          ver as demais.
        </p>
      ) : null}

      {open.error && !open.data ? (
        <ErrorBox message={errorMessage(open.error)} />
      ) : (
        <div
          aria-busy={open.isPlaceholderData || undefined}
          className={clsx(
            "flex min-h-[28rem] flex-1 gap-3 overflow-x-auto pb-2 transition-opacity duration-150",
            open.isPlaceholderData && "opacity-60",
          )}
        >
          {columns.map((status) => {
            const info = STATUS[status];
            const finalPage = status === "closed" ? closed : status === "cancelled" ? cancelled : null;
            const items = finalPage ? (finalPage.data?.items ?? []) : (grouped.get(status) ?? []);
            const count = finalPage ? (finalPage.data?.total ?? 0) : items.length;
            const loading = finalPage ? finalPage.isLoading : open.isLoading;
            const canDrop = dragging !== null && dropTargets.includes(status);
            const isSource = dragging?.status === status;
            return (
              <section
                key={status}
                aria-label={`${info.label}: ${loading ? "carregando" : `${count} OS`}`}
                onDragOver={(e) => {
                  if (!canDrop) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (overColumn !== status) setOverColumn(status);
                }}
                onDragLeave={(e) => {
                  // Passar por cima de um cartão da própria coluna também dispara o "leave".
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                  setOverColumn((c) => (c === status ? null : c));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const card = dragging;
                  endDrag();
                  // A leitura do início do arraste ainda vale (poucos segundos).
                  if (canDrop && card) void move(card, status, 5_000);
                }}
                className={clsx(
                  "flex w-72 shrink-0 flex-col rounded-xl border bg-surface-2/60 transition-[border-color,background-color,opacity] duration-150",
                  canDrop && overColumn === status && "border-brand bg-brand/5",
                  canDrop && overColumn !== status && "border-dashed border-brand/50",
                  !canDrop && "border-line",
                  dragging && !canDrop && !isSource && "opacity-50",
                )}
              >
                <header className="px-3 pt-2.5 pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: info.color }} />
                      <h2 className="truncate text-sm font-bold text-ink">{info.label}</h2>
                    </div>
                    <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-semibold text-ink-muted tabular-nums">
                      {loading ? "…" : count}
                    </span>
                  </div>
                  {finalPage && count > items.length ? (
                    <p className="mt-0.5 text-[11px] text-ink-subtle">As {items.length} mais recentes</p>
                  ) : null}
                </header>
                <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {loading ? (
                    <ColumnSkeleton />
                  ) : (
                    items.map((t) => (
                      <BoardCard
                        key={t.id}
                        ticket={t}
                        now={now}
                        targets={targetsFor(user, t)}
                        busy={preparing === t.id}
                        locked={preparing !== null && preparing !== t.id}
                        dragging={dragging?.id === t.id}
                        onDragStart={() => {
                          setDragging(t);
                          void queryClient.prefetchQuery({
                            queryKey: ["ticket", t.id],
                            queryFn: () => api.get<TicketDetail>(`/tickets/${t.id}`),
                            staleTime: 5_000,
                          });
                        }}
                        onDragEnd={endDrag}
                        onMove={(to) => void move(t, to)}
                      />
                    ))
                  )}
                  {!loading && items.length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs text-ink-muted">Nenhuma OS</p>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {noTech ? (
        <Dialog
          open
          onClose={() => setNoTech(null)}
          title="OS sem técnico"
          description={
            <span>
              <span className="font-mono text-xs">{noTech.ticket.code}</span> · {noTech.ticket.title}
            </span>
          }
          footer={
            <>
              <Button onClick={() => setNoTech(null)}>Voltar</Button>
              <Button
                variant="primary"
                autoFocus
                onClick={() => {
                  const id = noTech.ticket.id;
                  setNoTech(null);
                  openTicket(id);
                }}
              >
                Escolher técnico
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-sm text-ink-muted">
            <p>
              Para {TRANSITION_ACTION[noTech.to].toLowerCase()}, a OS precisa de um técnico. Escolha o técnico na OS e depois
              mude o status.
            </p>
            {selfAssign ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2.5">
                <span className="min-w-0 flex-1 text-xs">
                  Vai atender você mesmo, a distância? Você vira o executor e o analista responsável.
                </span>
                <Button
                  size="sm"
                  onClick={() => {
                    setPending(noTech);
                    setNoTech(null);
                  }}
                >
                  Assumir eu mesmo
                </Button>
              </div>
            ) : null}
          </div>
        </Dialog>
      ) : null}

      {pending ? (
        <TransitionDialog
          key={`${pending.ticket.id}-${pending.to}`}
          ticket={pending.ticket}
          to={pending.to}
          onClose={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}
