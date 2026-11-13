"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, ClipboardPlus, Hand, Hash, MapPin, Search, UserRound, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PriorityBadge, SlaCountdown, StatusBadge } from "@/components/badges";
import { Tabs } from "@/components/motion";
import { isOpenStatus } from "@/components/operacao/hooks";
import { ClaimButton, RefreshFailed } from "@/components/operacao/status";
import { useToast } from "@/components/Toaster";
import { QuickEditButton } from "@/components/ticket/QuickEditButton";
import { TicketLink } from "@/components/ticket/TicketLink";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Textarea,
} from "@/components/ui";
import { useNow } from "@/components/useNow";
import { ApiError, api, errorMessage, type Query } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatRelative } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { CLIENT_STATUS } from "@/lib/portal";
import { useCustomers } from "@/lib/queries";
import type { Page, TicketDetail, TicketListItem, TicketStatus, UUID } from "@/lib/types";

type Tab = "new" | "all";
type Situation = "all" | "open" | "done" | "cancelled";

/** Esperando a central: recebidas ou em análise (as que o cliente ainda pode cancelar no portal). */
const WAITING: TicketStatus[] = ["new", "triage"];
const PAGE_SIZE = 50;

const SITUATIONS: { key: Situation; label: string; query: Query }[] = [
  { key: "all", label: "Todas", query: {} },
  { key: "open", label: "Abertas", query: { open_only: true } },
  { key: "done", label: "Concluídas", query: { status: ["resolved", "closed"] } },
  { key: "cancelled", label: "Canceladas", query: { status: ["cancelled"] } },
];

type PullResult = { detail: TicketDetail | null; analysed: boolean; warning: string | null };

/** Recusar = cancelar a solicitação com o motivo (fica no histórico da OS). */
function DeclineDialog({ ticket, onClose }: { ticket: TicketListItem; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const text = reason.trim();
  const invalid = text.length < 3;
  const decline = useMutation({
    mutationFn: () =>
      api.post<TicketDetail>(`/tickets/${ticket.id}/transition`, {
        to_status: "cancelled",
        note: text,
        expected_version: ticket.version,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["ticket", ticket.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["solicitacoes"] });
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      toast({ title: `${ticket.code} recusada`, description: "A solicitação foi cancelada e saiu da caixa.", tone: "success" });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ["solicitacoes"] });
        void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
        toast({
          title: "A OS foi alterada por outra pessoa",
          description: "Recarregamos a caixa. Confira a solicitação e tente de novo.",
          tone: "error",
        });
        onClose();
      }
    },
  });
  const apiError = decline.error && !(decline.error instanceof ApiError && decline.error.status === 409) ? decline.error : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Recusar solicitação"
      description={
        <span>
          <span className="font-mono text-xs">{ticket.code}</span> · {ticket.title}
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Voltar</Button>
          <Button variant="danger" type="submit" form="decline-form" loading={decline.isPending}>
            Recusar solicitação
          </Button>
        </>
      }
    >
      <form
        id="decline-form"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!invalid) decline.mutate();
        }}
        className="flex flex-col gap-3"
      >
        <p className="text-sm text-ink-muted">
          A solicitação fica cancelada e sai da caixa. No portal, o cliente vê a solicitação como cancelada; o motivo fica no
          histórico da OS, só para a equipe.
        </p>
        <Field label="Motivo" required hint="Ex.: repetida de outra OS, fora do contrato, aberta por engano.">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            autoFocus
            aria-invalid={touched && invalid}
            placeholder="Por que a solicitação não vai virar atendimento?"
          />
        </Field>
        {touched && invalid ? <ErrorBox message="Escreva o motivo (pelo menos 3 letras)." /> : null}
        {apiError ? <ErrorBox message={errorMessage(apiError)} /> : null}
      </form>
    </Dialog>
  );
}

function RequestRow({
  ticket: t,
  now,
  meId,
  pulling,
  onPull,
  onDecline,
}: {
  ticket: TicketListItem;
  now: number;
  meId: UUID | null;
  pulling: boolean;
  onPull: () => void;
  onDecline: () => void;
}) {
  const open = isOpenStatus(t.status);
  const waiting = WAITING.includes(t.status);
  // Cor só quando sinaliza problema: P1 e P2 aparecem, P3 e P4 não.
  const urgent = t.priority === "critical" || t.priority === "high";
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--row-hover)] sm:flex-row sm:items-start sm:gap-4 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-ink">{t.customer?.name ?? "Sem cliente"}</span>
          <StatusBadge status={t.status} />
          {urgent ? <PriorityBadge priority={t.priority} compact /> : null}
          <span className="text-xs text-ink-muted">Cliente vê: {CLIENT_STATUS[t.status]}</span>
        </div>
        {/* Um link só (nº e título): clique abre ao lado, Ctrl+clique abre a página da OS. */}
        <TicketLink ticketId={t.id} className="mt-1 block font-semibold text-ink hover:text-brand">
          <span className="mr-1.5 font-mono text-xs font-normal text-ink-subtle">{t.code}</span>
          {t.title}
        </TicketLink>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          {t.location ? (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3.5 shrink-0" />
              {t.location.name}
              {t.location.city ? ` · ${t.location.city}` : ""}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <UserRound className="size-3.5 shrink-0" />
            {t.requester_name ?? "Cliente"} · aberta {formatRelative(t.created_at, now)}
          </span>
          {t.client_reference ? (
            <span className="inline-flex items-center gap-1">
              <Hash className="size-3.5 shrink-0" />
              Chamado do cliente: {t.client_reference}
            </span>
          ) : null}
          {open ? <SlaCountdown ticket={t} /> : null}
          {t.owner ? <span>{t.owner.id === meId ? "Na sua fila" : `Na fila de ${t.owner.name}`}</span> : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-end sm:self-start">
        {waiting ? (
          <Button size="sm" variant="ghost" onClick={onDecline} disabled={pulling}>
            Recusar
          </Button>
        ) : null}
        {open && !t.owner ? (
          <Button size="sm" onClick={onPull} loading={pulling} title="Vai para a sua fila e o cliente passa a ver “Em análise”">
            {pulling ? null : <Hand className="size-4" />}
            Puxar e analisar
          </Button>
        ) : open && t.owner?.id !== meId ? (
          <ClaimButton code={t.code} busy={pulling} onClaim={onPull} />
        ) : null}
        <QuickEditButton ticketId={t.id} code={t.code} />
      </div>
    </li>
  );
}

/**
 * Solicitações: o que os clientes abrem no portal (antes vinha pelo WhatsApp ou e-mail e a central
 * digitava a OS). A central analisa, puxa para a fila, escolhe o técnico e segue o fluxo da OS.
 */
export default function RequestsInboxPage() {
  const now = useNow(60_000);
  const { user } = useAuth();
  const meId = user?.id ?? null;
  const router = useRouter();
  const panel = useTicketPanel();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const customers = useCustomers();
  const [tab, setTab] = useState<Tab>("new");
  const [situation, setSituation] = useState<Situation>("all");
  const [customerId, setCustomerId] = useState("");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  const [pulling, setPulling] = useState<ReadonlySet<UUID>>(() => new Set());
  const [declining, setDeclining] = useState<TicketListItem | null>(null);

  // Esperando a central: a mais antiga primeiro (quem espera há mais tempo). Todas: a mais nova primeiro.
  const params: Query =
    tab === "new"
      ? { source: "portal", status: WAITING, order_by: "created_at", page, page_size: PAGE_SIZE }
      : {
          source: "portal",
          ...SITUATIONS.find((s) => s.key === situation)?.query,
          customer_id: customerId || undefined,
          q: q || undefined,
          order_by: "-created_at",
          page,
          page_size: PAGE_SIZE,
        };
  const list = useQuery({
    queryKey: ["solicitacoes", "list", params],
    queryFn: () => api.get<Page<TicketListItem>>("/tickets", params),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const count = useQuery({
    queryKey: ["solicitacoes", "count"],
    queryFn: () => api.get<{ pending: number }>("/portal/inbox-count"),
    refetchInterval: 60_000,
  });

  // Puxar e analisar: a OS vai para a minha fila e, se ainda estava como recebida, entra em análise
  // (o cliente vê "Em análise" no portal). Depois abre ao lado para escolher o tipo e o técnico.
  const pull = useMutation({
    mutationFn: async (t: TicketListItem): Promise<PullResult> => {
      let detail: TicketDetail | null = null;
      if (t.owner?.id !== meId) detail = await api.post<TicketDetail>(`/tickets/${t.id}/claim`);
      if ((detail?.status ?? t.status) !== "new") return { detail, analysed: false, warning: null };
      try {
        detail = await api.post<TicketDetail>(`/tickets/${t.id}/transition`, {
          to_status: "triage",
          expected_version: detail?.version ?? t.version,
        });
        return { detail, analysed: true, warning: null };
      } catch (error) {
        // Já está na minha fila: só a análise não entrou (ex.: alguém mexeu na OS no mesmo instante).
        if (detail) return { detail, analysed: false, warning: errorMessage(error) };
        throw error;
      }
    },
    onMutate: (t) => setPulling((ids) => new Set(ids).add(t.id)),
    onSettled: (_data, _error, t) =>
      setPulling((ids) => {
        const next = new Set(ids);
        next.delete(t.id);
        return next;
      }),
    onSuccess: ({ detail, analysed, warning }, t) => {
      if (detail) {
        const updated = detail;
        queryClient.setQueryData(["ticket", t.id], updated);
        // A linha muda na hora (analista e status), sem esperar a releitura: nada de segundo clique.
        queryClient.setQueriesData<Page<TicketListItem>>({ queryKey: ["solicitacoes", "list"] }, (old) =>
          old
            ? {
                ...old,
                items: old.items.map((i) =>
                  i.id === t.id ? { ...i, owner: updated.owner, status: updated.status, version: updated.version } : i,
                ),
              }
            : old,
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["solicitacoes"] });
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      if (warning) {
        toast({ title: `${t.code} está na sua fila, mas continua como recebida`, description: warning, tone: "error" });
      } else {
        toast({
          title: `${t.code} está na sua fila`,
          description: analysed ? "O cliente passa a ver “Em análise” no portal." : undefined,
          tone: "success",
        });
      }
      if (panel) panel.open(t.id);
      else router.push(`/chamados/${t.id}`);
    },
    onError: (error, t) => {
      void queryClient.invalidateQueries({ queryKey: ["solicitacoes"] });
      toast({ title: `Não foi possível puxar a ${t.code}`, description: errorMessage(error), tone: "error" });
    },
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  // A última página esvaziou (recusadas ou puxadas por outra pessoa): volta para a primeira.
  if (page > 1 && list.data && !list.isPlaceholderData && items.length === 0) setPage(1);
  const first = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const last = Math.min(page * PAGE_SIZE, total);
  const hasFilters = tab === "all" && (situation !== "all" || Boolean(customerId) || Boolean(search.trim()));
  const clearFilters = () => {
    setSituation("all");
    setCustomerId("");
    setSearch("");
    setPage(1);
  };
  const row = (t: TicketListItem) => (
    <RequestRow
      key={t.id}
      ticket={t}
      now={now}
      meId={meId}
      pulling={pulling.has(t.id)}
      onPull={() => {
        if (!pulling.has(t.id)) pull.mutate(t);
      }}
      onDecline={() => setDeclining(t)}
    />
  );
  const unclaimed = items.filter((t) => !t.owner);
  const claimed = items.filter((t) => t.owner);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Solicitações"
        description="Chamados que os clientes abrem pelo portal. Ao puxar, a solicitação vai para a sua fila e o cliente passa a ver “Em análise”."
      />
      <Tabs<Tab>
        items={[
          { key: "new", label: "Esperando a central", count: count.data?.pending ?? null },
          { key: "all", label: "Todas do portal" },
        ]}
        value={tab}
        onChange={(next) => {
          setTab(next);
          setPage(1);
        }}
        ariaLabel="Solicitações"
        className="mb-4"
      />

      {tab === "all" ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Nº, título ou chamado do cliente"
              aria-label="Buscar solicitação"
              className="pl-9"
            />
          </div>
          <Select
            value={customerId}
            onChange={(e) => {
              setCustomerId(e.target.value);
              setPage(1);
            }}
            aria-label="Cliente"
            className="w-full sm:w-56"
          >
            <option value="">Todos os clientes</option>
            {customers.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <div role="group" aria-label="Situação" className="flex flex-wrap gap-1">
            {SITUATIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                aria-pressed={situation === s.key}
                onClick={() => {
                  setSituation(s.key);
                  setPage(1);
                }}
                className={clsx(
                  "h-8 rounded-full border px-3 text-xs font-medium transition-colors",
                  situation === s.key
                    ? "border-brand/40 bg-brand-soft text-brand-ink"
                    : "border-line bg-surface text-ink-muted hover:border-line-strong hover:text-ink",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          {hasFilters ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              <X className="size-3.5" />
              Limpar filtros
            </Button>
          ) : null}
        </div>
      ) : null}

      {list.error && list.data ? (
        <RefreshFailed
          at={list.errorUpdatedAt}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
          className="mb-3"
        />
      ) : null}

      {list.isLoading ? (
        <LoadingBlock rows={4} />
      ) : list.error && !list.data ? (
        <ErrorBox message={errorMessage(list.error)} />
      ) : !items.length ? (
        <Card>
          <EmptyState
            icon={<ClipboardPlus />}
            title={
              tab === "new"
                ? "Nenhuma solicitação esperando"
                : hasFilters
                  ? "Nenhuma solicitação com esses filtros"
                  : "Nenhuma solicitação do portal ainda"
            }
            description={
              hasFilters
                ? undefined
                : "Quando um cliente abrir um chamado pelo portal ou pelo app instalado no Windows, ele aparece aqui na hora."
            }
            action={hasFilters ? <Button onClick={clearFilters}>Limpar filtros</Button> : undefined}
          />
        </Card>
      ) : (
        <Card
          className={clsx("overflow-hidden transition-opacity duration-150", list.isPlaceholderData && "opacity-60")}
        >
          <div aria-busy={list.isPlaceholderData || undefined}>
            {tab === "new" ? (
              <>
                {unclaimed.length ? (
                  <>
                    <p className="border-b border-line bg-[var(--table-head)] px-4 py-2 text-[11px] font-bold tracking-[0.06em] text-ink-muted uppercase sm:px-5">
                      Ninguém pegou · {unclaimed.length}
                    </p>
                    <ul className="divide-y divide-line">{unclaimed.map(row)}</ul>
                  </>
                ) : null}
                {claimed.length ? (
                  <>
                    <p
                      className={clsx(
                        "border-b border-line bg-[var(--table-head)] px-4 py-2 text-[11px] font-bold tracking-[0.06em] text-ink-muted uppercase sm:px-5",
                        unclaimed.length && "border-t",
                      )}
                    >
                      Com analista · {claimed.length}
                    </p>
                    <ul className="divide-y divide-line">{claimed.map(row)}</ul>
                  </>
                ) : null}
              </>
            ) : (
              <ul className="divide-y divide-line">{items.map(row)}</ul>
            )}
          </div>
          {total > items.length || page > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-xs text-ink-muted sm:px-5">
              <span className="tabular-nums">
                Mostrando {first}–{last} de {total}
              </span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  <ChevronLeft className="size-4" />
                  Anterior
                </Button>
                <Button size="sm" variant="ghost" disabled={last >= total} onClick={() => setPage((p) => p + 1)}>
                  Próxima
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      )}

      {declining ? <DeclineDialog key={declining.id} ticket={declining} onClose={() => setDeclining(null)} /> : null}
    </div>
  );
}
