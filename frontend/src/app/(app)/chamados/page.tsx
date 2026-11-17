"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { Tabs } from "@/components/motion";
import { useToast } from "@/components/Toaster";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import { Button, buttonClassName, Card, ErrorBox, LoadingBlock, PageHeader } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import type { Page, QueuesOut, TicketListItem, UUID } from "@/lib/types";
import { ActiveFilters } from "./_lista/ActiveFilters";
import { IDENTIFIER_SORT, splitOrder, useColumns } from "./_lista/columns";
import { EmptyList } from "./_lista/EmptyList";
import { downloadTicketsCsv, EXPORT_LIMIT } from "./_lista/exportTickets";
import { FilterBar } from "./_lista/FilterBar";
import { MoreFilters } from "./_lista/MoreFilters";
import { Pagination } from "./_lista/Pagination";
import {
  apiQuery,
  CLEAR_FILTERS,
  DEFAULT_ORDER,
  type Filters,
  hasAnyFilter,
  ignoresView,
  isNumberSearch,
  isOpenStatus,
  MORE_FILTER_KEYS,
  moreFilterCount,
  ORDERS,
  useListState,
  type View,
  VIEWS,
  writeListParams,
} from "./_lista/params";
import { BulkTagsDialog, type BulkTagMode, SelectionBar } from "./_lista/Selection";
import { TicketsTable } from "./_lista/TicketsTable";
import { ColumnsMenu, type ExportScope, ExportMenu } from "./_lista/Toolbar";

const countOs = (n: number) => `${n.toLocaleString("pt-BR")} OS`;

const NO_SELECTION: ReadonlySet<UUID> = new Set();

/** Tira os filtros de "Mais filtros" (os da fileira e a busca continuam). */
const CLEAR_MORE = Object.fromEntries(MORE_FILTER_KEYS.map((key) => [key, null]));

function TicketsView() {
  const router = useRouter();
  const { user } = useAuth();
  const manager = canManageTickets(user?.role);
  // Aba, filtros, busca, ordem, página e itens por página vêm da URL (e voltam para ela): F5, Voltar e
  // links mantêm a lista.
  const state = useListState();
  const { view, filters, page, pageSize, order, q } = state;
  // OS aberta no painel lateral (clique na linha), como no Field Control: a lista continua à vista.
  const ticketPanel = useTicketPanel();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  // Um relógio para a lista toda: "atrasada há 35min" e a virada do dia.
  const now = useNow(60_000);
  const listTop = useRef<HTMLDivElement>(null);
  const columns = useColumns(manager);
  const [moreOpen, setMoreOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportScope | null>(null);
  // Etiquetas em massa: as OS marcadas quando o diálogo abriu (a lista pode mudar em tempo real).
  const [bulk, setBulk] = useState<{ mode: BulkTagMode; tickets: TicketListItem[] } | null>(null);

  // Filas dos analistas (quem acompanha cada OS), com quantas estão abertas: o filtro "Analista".
  const queues = useQuery({
    queryKey: ["tickets", "queues"],
    queryFn: ({ signal }) => api.get<QueuesOut>("/queues", undefined, { signal }),
    enabled: manager,
    staleTime: 30_000,
  });
  const params = apiQuery(state);
  const query = useQuery({
    queryKey: ["tickets", "list", params, page, pageSize],
    queryFn: ({ signal }) => api.get<Page<TicketListItem>>("/tickets", { ...params, page, page_size: pageSize }, { signal }),
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const items = data?.items ?? [];

  // Seleção: as OS marcadas nesta página (como no Field Control). Outra página, filtro, busca ou ordem
  // começam sem nada marcado; a OS que sai da página (tempo real) sai da seleção.
  const listKey = JSON.stringify([params, page, pageSize]);
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<UUID> }>({ key: listKey, ids: NO_SELECTION });
  const marked = selection.key === listKey ? selection.ids : NO_SELECTION;
  const selected = items.filter((t) => marked.has(t.id));
  const toggle = (id: UUID) =>
    setSelection((prev) => {
      const next = new Set(prev.key === listKey ? prev.ids : NO_SELECTION);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { key: listKey, ids: next };
    });
  const togglePage = () =>
    setSelection((prev) => {
      const current = prev.key === listKey ? prev.ids : NO_SELECTION;
      const all = items.length > 0 && items.every((t) => current.has(t.id));
      return { key: listKey, ids: all ? NO_SELECTION : new Set(items.map((t) => t.id)) };
    });
  const clearSelection = () => setSelection({ key: listKey, ids: NO_SELECTION });

  // Assumir: a OS vai para a fila de quem assumiu (o técnico continua o mesmo).
  const claim = useMutation({
    mutationFn: (t: TicketListItem) => api.post(`/tickets/${t.id}/claim`),
    onSuccess: (_, t) => {
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      void queryClient.invalidateQueries({ queryKey: ["ticket", t.id] });
      toast({ title: `Você assumiu a OS ${t.number}: está na sua fila`, tone: "success" });
    },
    onError: (e) => toast({ title: "Não foi possível assumir a OS", description: errorMessage(e), tone: "error" }),
  });
  const claimTicket = async (t: TicketListItem) => {
    const owner = t.owner;
    // Tirar a OS da fila de um colega pede confirmação; OS sem analista vai direto.
    if (owner && owner.id !== user?.id) {
      const ok = await confirm({
        title: `Puxar a OS ${t.number} para a sua fila?`,
        description: `Ela sai da fila de ${owner.name}. O técnico continua o mesmo.`,
        confirmLabel: "Puxar para mim",
      });
      if (!ok) return;
    }
    claim.mutate(t);
  };

  // A lista encolheu (OS concluídas por outros, filtro) e a página ficou vazia: vai para a última com OS.
  useEffect(() => {
    if (!data || query.isPlaceholderData || data.items.length > 0 || data.total === 0 || page === 1) return;
    writeListParams({ page: Math.ceil(data.total / pageSize), view }, { keepPage: true });
  }, [data, query.isPlaceholderData, page, pageSize, view]);

  /** Troca filtros. A aba de agora fica escrita na URL: um filtro novo nunca muda a aba sozinho. */
  const update = (patch: Partial<Filters>) => writeListParams({ ...patch, view });
  const chooseView = (next: View) => {
    // As abas de OS em aberto não mostram status finais: eles saem do filtro.
    writeListParams({ view: next, status: next === "todas" ? filters.status : filters.status.filter(isOpenStatus) });
  };
  // Fila de outro analista abre em "Em aberto" ("Minhas" já é a fila de quem está vendo).
  const chooseOwner = (value: UUID | "none" | "") =>
    writeListParams({ owner_id: value === "none" ? "" : value, no_owner: value === "none", view: view === "minhas" ? "abertos" : view });
  const clearAll = () => writeListParams({ ...CLEAR_FILTERS, q: null, view });
  const goToPage = (next: number) => {
    writeListParams({ page: next, view }, { keepPage: true });
    // Do rodapé, volta para o começo da lista (só se o começo saiu da tela).
    const top = listTop.current;
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
  };
  const openTicket = (id: UUID) => (ticketPanel ? ticketPanel.open(id) : router.push(`/chamados/${id}`));

  /** Planilha (CSV montado pela API) do filtro de agora, todas as páginas, ou só das OS marcadas. */
  const exportCsv = async (scope: ExportScope) => {
    if (exporting) return;
    const ids = selected.map((t) => t.id);
    const total = data?.total ?? 0;
    if (scope === "selected" && !ids.length) return;
    if (scope === "filtered" && total > EXPORT_LIMIT) {
      const ok = await confirm({
        title: `Exportar as primeiras ${countOs(EXPORT_LIMIT)}?`,
        description: `São ${countOs(total)} com estes filtros e a planilha leva no máximo ${countOs(EXPORT_LIMIT)}. Para levar todas, filtre por período (Criação) e exporte em partes.`,
        confirmLabel: "Exportar",
      });
      if (!ok) return;
    }
    setExporting(scope);
    try {
      const filename = await downloadTicketsCsv(scope === "selected" ? { ids, order_by: order } : params);
      const rows = scope === "selected" ? ids.length : Math.min(total, EXPORT_LIMIT);
      toast({ title: `${countOs(rows)} na planilha`, description: filename, tone: "success" });
    } catch (error) {
      toast({ title: "Não foi possível exportar", description: errorMessage(error), tone: "error" });
    } finally {
      setExporting(null);
    }
  };

  const allViews = ignoresView(state);
  const numberSearch = isNumberSearch(q);
  const viewInfo = VIEWS.find((v) => v.key === view) ?? VIEWS[0];
  const anyFilter = hasAnyFilter(filters);
  const closedInOpenView = view !== "todas" && !allViews ? filters.status.filter((s) => !isOpenStatus(s)) : [];
  const ownerName = queues.data?.queues.find((x) => x.user.id === filters.owner_id)?.user.name;
  // A ordem de agora sem cabeçalho à vista (ex.: um link do dashboard por prazo) aparece como chip.
  const orderField = splitOrder(order).field;
  const orderShown = orderField === IDENTIFIER_SORT.field || columns.visible.some((c) => c.sort?.field === orderField);
  const orderLabel = order !== DEFAULT_ORDER && !orderShown ? (ORDERS.find((o) => o.value === order)?.label ?? null) : null;
  // A Nova OS já abre com a loja (ou o cliente) do filtro.
  const newHref = filters.location_id
    ? `/chamados/novo?location_id=${filters.location_id}`
    : filters.customer_id
      ? `/chamados/novo?customer_id=${filters.customer_id}`
      : "/chamados/novo";
  const total = data?.total ?? 0;
  // "312 OS em aberto", "28 OS em aberto com os filtros", "15.351 OS no total", "40 OS na busca".
  const suffix = anyFilter ? " com os filtros" : q ? " na busca" : "";
  const phrase = view === "todas" && suffix ? "" : ` ${viewInfo.phrase}`;
  const description = !data ? "Ordens de serviço" : allViews ? `${countOs(total)} em todas as abas` : `${countOs(total)}${phrase}${suffix}`;
  const scopeNote =
    allViews && view !== "todas"
      ? filters.number !== null
        ? "O identificador procura em todas as OS, em qualquer aba (inclusive as fechadas)."
        : "Busca pelo nº da OS: olha todas as OS, em qualquer aba (inclusive as fechadas)."
      : null;
  // Página vazia de uma lista que encolheu: carrega enquanto vai para a última página com OS.
  const loadingRows = query.isLoading || (data !== undefined && data.items.length === 0 && data.total > 0 && page > 1);
  const table = {
    columns: columns.visible,
    order,
    onSort: (next: string) => writeListParams({ order_by: next, view }),
    onToggle: toggle,
    onTogglePage: togglePage,
    edit: manager,
    onOpen: openTicket,
    ctx: { now, userId: user?.id, onClaim: (t: TicketListItem) => void claimTicket(t), claiming: claim.isPending },
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Chamados"
        description={description}
        actions={
          <>
            <ExportMenu total={data ? data.total : null} selected={selected.length} busy={exporting !== null} onExport={(scope) => void exportCsv(scope)} />
            <ColumnsMenu columns={columns} />
            <Button
              onClick={() => void queryClient.invalidateQueries({ queryKey: ["tickets"] })}
              aria-busy={query.isFetching || undefined}
              title="Buscar a lista de novo"
            >
              <RefreshCw aria-hidden className={clsx("size-4", query.isFetching && "animate-spin")} />
              Atualizar
            </Button>
            <Link href={newHref} className={buttonClassName("primary")}>
              <Plus aria-hidden className="size-4" />
              Nova OS
            </Link>
          </>
        }
      />

      <div className="mb-4 border-b border-line">
        <Tabs className="-mb-px" items={VIEWS} value={view} onChange={chooseView} ariaLabel="Visões dos chamados" />
      </div>

      <FilterBar
        state={state}
        onChange={update}
        onAllViews={() => chooseView("todas")}
        moreCount={moreFilterCount(filters)}
        onOpenMore={() => setMoreOpen(true)}
      />

      {anyFilter || orderLabel ? (
        <ActiveFilters
          filters={filters}
          ownerName={ownerName}
          userId={user?.id}
          orderLabel={orderLabel}
          onChange={update}
          onResetOrder={() => writeListParams({ order_by: DEFAULT_ORDER, view })}
          onClear={anyFilter ? clearAll : null}
        />
      ) : null}

      <Card className="overflow-hidden">
        <div ref={listTop} className="scroll-mt-20" />
        {selected.length ? (
          <SelectionBar
            count={selected.length}
            exporting={exporting === "selected"}
            onExport={() => void exportCsv("selected")}
            onTags={(mode) => setBulk({ mode, tickets: selected })}
            onClear={clearSelection}
          />
        ) : null}
        {scopeNote ? (
          <p role="status" className="border-b border-line px-4 py-2 text-xs text-ink-muted">
            {scopeNote}
          </p>
        ) : null}

        {loadingRows ? (
          <div aria-busy="true">
            <span role="status" className="sr-only">
              Carregando a lista...
            </span>
            <TicketsTable rows={null} skeletonRows={Math.min(pageSize, 10)} selected={NO_SELECTION} {...table} />
          </div>
        ) : !data ? (
          <div className="p-4">
            <ErrorBox message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
          </div>
        ) : data.items.length === 0 ? (
          <EmptyList
            view={view}
            q={q}
            numberSearch={numberSearch}
            number={filters.number}
            otherFilters={hasAnyFilter({ ...filters, number: null })}
            closedInOpenView={closedInOpenView}
            newHref={newHref}
            onClear={clearAll}
            onAllViews={() => chooseView("todas")}
          />
        ) : (
          <>
            {/* Falhou só a atualização: a lista que já estava na tela continua. */}
            {query.error ? (
              <div className="border-b border-line px-4 py-2.5">
                <ErrorBox message={`Não deu para atualizar a lista: ${errorMessage(query.error)}`} onRetry={() => void query.refetch()} />
              </div>
            ) : null}
            {/* Apagada só enquanto mostra o resultado anterior (outra página, filtro ou busca), não a cada
                atualização em tempo real. */}
            <div
              className={clsx("transition-opacity duration-150", query.isPlaceholderData && "opacity-60")}
              aria-busy={query.isPlaceholderData || undefined}
            >
              <TicketsTable rows={data.items} skeletonRows={0} selected={marked} {...table} />
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={data.total}
              shown={data.items.length}
              onPage={goToPage}
              onPageSize={(size) => writeListParams({ page_size: size, view })}
            />
          </>
        )}
      </Card>

      {moreOpen ? (
        <MoreFilters
          view={view}
          filters={filters}
          onChange={update}
          onOwner={chooseOwner}
          onView={chooseView}
          onClear={() => writeListParams({ ...CLEAR_MORE, view })}
          queues={queues.data}
          userId={user?.id}
          total={data ? data.total : null}
          fetching={query.isPlaceholderData}
          onClose={() => setMoreOpen(false)}
        />
      ) : null}
      {bulk ? <BulkTagsDialog mode={bulk.mode} tickets={bulk.tickets} onClose={() => setBulk(null)} /> : null}
    </div>
  );
}

export default function TicketsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <TicketsView />
    </Suspense>
  );
}
