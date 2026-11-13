"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FilterX,
  Inbox,
  Plus,
  Rows3,
  Rows4,
  Search,
  SearchX,
  ShieldCheck,
  SlidersHorizontal,
  TicketX,
  UserCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { Tabs } from "@/components/motion";
import { readStored, writeStored } from "@/components/new-ticket/storage";
import { useToast } from "@/components/Toaster";
import { QuickEditButton } from "@/components/ticket/QuickEditButton";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import {
  Button,
  buttonClassName,
  Card,
  EmptyState,
  ErrorBox,
  fieldClassName,
  Input,
  LoadingBlock,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, STATUS } from "@/lib/constants";
import { formatDateTime, formatShort } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import type { Page, QueuesOut, TicketListItem, TicketStatus } from "@/lib/types";
import { ActiveFilters } from "./_lista/ActiveFilters";
import { AgendaCell, OwnerCell, SlaCell, StatusCell, StoreCell, TechnicianCell, TicketCard, TicketTitleCell } from "./_lista/cells";
import { downloadTicketsCsv, fetchTicketsForExport } from "./_lista/exportTickets";
import { FiltersCard } from "./_lista/FiltersCard";
import {
  apiQuery,
  CLEAR_FILTERS,
  filterCount,
  type Filters,
  hasAnyFilter,
  isNumberSearch,
  isOpenStatus,
  ORDERS,
  PAGE_SIZE,
  useListState,
  type View,
  VIEWS,
  writeListParams,
} from "./_lista/params";

/** Lista compacta ou confortável: preferência de cada pessoa, neste navegador. */
const DENSITY_KEY = "maxx.chamados.densidade";

const countOs = (n: number) => `${n.toLocaleString("pt-BR")} OS`;

/** Lista vazia: diz por quê (busca, filtro ou a própria aba) e oferece o próximo passo. */
function EmptyList({
  view,
  q,
  numberSearch,
  anyFilter,
  closedInOpenView,
  newHref,
  onClear,
  onAllViews,
}: {
  view: View;
  q: string;
  numberSearch: boolean;
  anyFilter: boolean;
  /** Status finais escolhidos numa aba que só mostra OS em aberto (link feito à mão). */
  closedInOpenView: TicketStatus[];
  newHref: string;
  onClear: () => void;
  onAllViews: () => void;
}) {
  const viewLabel = VIEWS.find((v) => v.key === view)?.label ?? "";
  const newTicket = (
    <Link href={newHref} className={buttonClassName("primary", "sm")}>
      <Plus aria-hidden className="size-4" />
      Nova OS
    </Link>
  );
  if (closedInOpenView.length) {
    const names = closedInOpenView.map((s) => `“${STATUS[s].label}”`).join(", ");
    return (
      <EmptyState
        icon={<FilterX />}
        title={`${names} ${closedInOpenView.length === 1 ? "não aparece" : "não aparecem"} em “${viewLabel}”`}
        description="Esta aba mostra só OS em aberto."
        action={
          <Button size="sm" onClick={onAllViews}>
            Ver em Todas
          </Button>
        }
      />
    );
  }
  if (q) {
    // A aba limitou a busca (a OS pode estar fechada): oferece procurar em todas.
    const narrowed = view !== "todas" && !numberSearch;
    return (
      <EmptyState
        icon={<SearchX />}
        title={numberSearch ? `Nenhuma OS com o nº ${q}` : `Nada encontrado para “${q}”`}
        description={
          narrowed
            ? `A busca olhou só a aba “${viewLabel}”.`
            : anyFilter
              ? "A busca respeita os filtros em uso."
              : "Confira o que foi digitado ou busque por outra palavra: loja, cliente, cidade ou título."
        }
        action={
          narrowed ? (
            <Button size="sm" onClick={onAllViews}>
              Buscar em todas as OS
            </Button>
          ) : anyFilter ? (
            <Button size="sm" onClick={onClear}>
              Limpar filtros
            </Button>
          ) : undefined
        }
      />
    );
  }
  if (anyFilter) {
    return (
      <EmptyState
        icon={<FilterX />}
        title="Nenhuma OS com estes filtros"
        description={view !== "todas" ? `Olhando só a aba “${viewLabel}”.` : undefined}
        action={
          <Button size="sm" onClick={onClear}>
            Limpar filtros
          </Button>
        }
      />
    );
  }
  if (view === "sla") {
    return <EmptyState icon={<ShieldCheck />} title="Nenhuma OS com SLA violado agora" description="As OS em aberto estão dentro do prazo." />;
  }
  if (view === "sem_tecnico") return <EmptyState icon={<UserCheck />} title="Todas as OS em aberto têm técnico" />;
  if (view === "minhas") {
    return (
      <EmptyState
        icon={<Inbox />}
        title="Nenhuma OS em aberto com você"
        description="Aqui aparecem as OS da sua fila e as que você executa."
        action={newTicket}
      />
    );
  }
  if (view === "abertos") return <EmptyState icon={<Inbox />} title="Nenhuma OS em aberto" action={newTicket} />;
  return <EmptyState icon={<TicketX />} title="Nenhuma OS ainda" action={newTicket} />;
}

function TicketsView() {
  const router = useRouter();
  const { user } = useAuth();
  const manager = canManageTickets(user?.role);
  // Aba, filtros, busca, ordem e página vêm da URL (e voltam para ela): F5, Voltar e links mantêm a lista.
  const state = useListState();
  const { view, filters, page, order } = state;
  const urlQ = state.q;
  // OS aberta no painel lateral (clique na linha), como no Field Control: a lista continua à vista.
  const ticketPanel = useTicketPanel();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  // Um relógio para a lista toda: "Hoje 14:00", "Atrasada há 35min" e a virada do dia.
  const now = useNow(60_000);
  const listTop = useRef<HTMLDivElement>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [compact, setCompact] = useState(() => readStored<string>("local", DENSITY_KEY) === "compacta");
  const [exporting, setExporting] = useState<string | null>(null);

  // Busca: o campo responde na hora e a URL (com a lista) acompanha quando a digitação para.
  const [search, setSearch] = useState(urlQ);
  const [syncedQ, setSyncedQ] = useState(urlQ);
  const debounced = useDebounced(search.trim(), 350);
  if (urlQ !== syncedQ) {
    // A busca mudou por fora (Voltar, link de outra tela, "Limpar filtros"): o campo acompanha.
    setSyncedQ(urlQ);
    if (urlQ !== debounced) setSearch(urlQ);
  }
  useEffect(() => {
    // Só quando a digitação parou: enquanto o atraso não alcança o campo, a URL fica como está.
    if (debounced !== search.trim() || debounced === urlQ) return;
    writeListParams({ q: debounced, view });
  }, [debounced, search, urlQ, view]);

  // Filas dos analistas (quem acompanha cada OS), com quantas estão abertas.
  const queues = useQuery({
    queryKey: ["tickets", "queues"],
    queryFn: () => api.get<QueuesOut>("/queues"),
    enabled: manager,
    staleTime: 30_000,
  });
  const params = apiQuery(state);
  const query = useQuery({
    queryKey: ["tickets", "list", params, page],
    queryFn: ({ signal }) => api.get<Page<TicketListItem>>("/tickets", { ...params, page, page_size: PAGE_SIZE }, { signal }),
    placeholderData: keepPreviousData,
  });
  const data = query.data;

  // Assumir: a OS vai para a fila de quem assumiu (o técnico continua o mesmo).
  const claim = useMutation({
    mutationFn: (t: TicketListItem) => api.post(`/tickets/${t.id}/claim`),
    onSuccess: (_, t) => {
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
      void queryClient.invalidateQueries({ queryKey: ["ticket", t.id] });
      toast({ title: `Você assumiu a ${t.code}: está na sua fila`, tone: "success" });
    },
    onError: (e) => toast({ title: "Não foi possível assumir a OS", description: errorMessage(e), tone: "error" }),
  });
  const claimTicket = async (t: TicketListItem) => {
    const owner = t.owner;
    // Tirar a OS da fila de um colega pede confirmação; OS sem analista vai direto.
    if (owner && owner.id !== user?.id) {
      const ok = await confirm({
        title: `Puxar a ${t.code} para a sua fila?`,
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
    writeListParams({ page: Math.ceil(data.total / PAGE_SIZE), view }, { keepPage: true });
  }, [data, query.isPlaceholderData, page, view]);

  /** Troca filtros. A aba de agora fica escrita na URL: um filtro novo nunca muda a aba sozinho. */
  const update = (patch: Partial<Filters>) => writeListParams({ ...patch, view });
  const chooseView = (next: View) => {
    // As abas de OS em aberto não mostram status finais: eles saem do filtro.
    writeListParams({ view: next, status: next === "todas" ? filters.status : filters.status.filter(isOpenStatus) });
  };
  const clear = () => {
    setSearch("");
    writeListParams({ ...CLEAR_FILTERS, q: null, view });
  };
  const goToPage = (next: number) => {
    writeListParams({ page: next, view }, { keepPage: true });
    // Do rodapé, volta para o começo da lista (só se o começo saiu da tela).
    const top = listTop.current;
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
  };
  const toggleDensity = () => {
    const next = !compact;
    setCompact(next);
    writeStored("local", DENSITY_KEY, next ? "compacta" : null);
  };
  const openTicket = (id: string) => (ticketPanel ? ticketPanel.open(id) : router.push(`/chamados/${id}`));
  const onRowClick = (e: React.MouseEvent<HTMLTableRowElement>, t: TicketListItem) => {
    // Só o clique na própria linha (não o que vem de uma janela aberta a partir dela).
    if (!e.currentTarget.contains(e.target as Node)) return;
    // Arrastou para copiar um texto (loja, endereço, nº da OS): não abre nada.
    if (window.getSelection()?.toString()) return;
    if (e.ctrlKey || e.metaKey) {
      window.open(`/chamados/${t.id}`, "_blank", "noopener");
      return;
    }
    openTicket(t.id);
  };

  /** Planilha (CSV) com todas as OS do filtro de agora, não só a página. */
  const exportCsv = async () => {
    if (exporting) return;
    setExporting("...");
    try {
      const rows = await fetchTicketsForExport(
        params,
        (done, total) => setExporting(`${done.toLocaleString("pt-BR")} de ${total.toLocaleString("pt-BR")}`),
        (total) =>
          confirm({
            title: `Exportar ${countOs(total)}?`,
            description: "A planilha fica grande e leva alguns segundos. Com filtros, ela sai menor.",
            confirmLabel: "Exportar",
          }),
      );
      if (!rows) return;
      downloadTicketsCsv(rows);
      toast({ title: `${countOs(rows.length)} na planilha`, tone: "success" });
    } catch (error) {
      toast({ title: "Não foi possível exportar", description: errorMessage(error), tone: "error" });
    } finally {
      setExporting(null);
    }
  };

  const numberSearch = isNumberSearch(urlQ);
  const viewInfo = VIEWS.find((v) => v.key === view) ?? VIEWS[0];
  const anyFilter = hasAnyFilter(filters);
  const advancedCount = filterCount(filters);
  const closedInOpenView = view !== "todas" && !numberSearch ? filters.status.filter((s) => !isOpenStatus(s)) : [];
  const queueValue = filters.no_owner ? "none" : filters.owner_id;
  const ownerName = queues.data?.queues.find((x) => x.user.id === filters.owner_id)?.user.name;
  // A Nova OS já abre com a loja (ou o cliente) do filtro.
  const newHref = filters.location_id
    ? `/chamados/novo?location_id=${filters.location_id}`
    : filters.customer_id
      ? `/chamados/novo?customer_id=${filters.customer_id}`
      : "/chamados/novo";
  const total = data?.total ?? 0;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const first = data ? (data.page - 1) * data.page_size + 1 : 0;
  // "312 OS em aberto", "28 OS em aberto com os filtros", "15.351 OS no total", "40 OS na busca".
  const suffix = anyFilter ? " com os filtros" : urlQ ? " na busca" : "";
  const phrase = view === "todas" && suffix ? "" : ` ${viewInfo.phrase}`;
  const description = !data
    ? "Ordens de serviço"
    : numberSearch
      ? `Busca pelo nº em todas as OS: ${countOs(total)}`
      : `${countOs(total)}${phrase}${suffix}`;
  const rowClass = compact ? "[&>td]:py-1.5" : undefined;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Chamados"
        description={description}
        actions={
          <>
            <div className="relative min-w-0 flex-1 sm:w-80 sm:flex-none">
              <Search aria-hidden className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-subtle" />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar nº, loja, cliente, cidade, título..."
                title="Nº da OS, título, loja (nome, código ou cidade), cliente, técnico, nº do chamado do cliente ou descrição"
                aria-label="Buscar chamados"
                className="pl-9"
              />
            </div>
            <Button onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters} aria-controls="chamados-filtros">
              <SlidersHorizontal aria-hidden className="size-4" />
              Filtros
              {advancedCount > 0 ? (
                <span className="ml-0.5 rounded-full bg-brand px-1.5 text-[11px] font-semibold text-white dark:bg-brand-strong">
                  {advancedCount}
                  <span className="sr-only"> em uso</span>
                </span>
              ) : null}
            </Button>
            <Button
              onClick={() => void exportCsv()}
              loading={Boolean(exporting)}
              disabled={!data || total === 0}
              title="Baixa uma planilha (CSV) com todas as OS dos filtros de agora"
            >
              {exporting ? null : <Download aria-hidden className="size-4" />}
              {exporting ? `Exportando ${exporting}` : "Exportar"}
            </Button>
            <Link href={newHref} className={buttonClassName("primary")}>
              <Plus aria-hidden className="size-4" />
              Nova OS
            </Link>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line">
        <Tabs className="-mb-px" items={VIEWS} value={view} onChange={chooseView} ariaLabel="Visões dos chamados" />
        {manager ? (
          // Fila de um analista: para ver o que está com ele e, se preciso, puxar a OS para si.
          <label className="mb-1.5 flex items-center gap-2">
            <Users aria-hidden className="size-4 text-ink-subtle" />
            <span className="text-xs font-semibold whitespace-nowrap text-ink/80">Fila de</span>
            <select
              value={queueValue}
              onChange={(e) => {
                const value = e.target.value;
                // "Minhas" já é a fila de quem está vendo: a fila de outro analista abre em "Em aberto".
                writeListParams({
                  owner_id: value === "none" ? "" : value,
                  no_owner: value === "none",
                  view: view === "minhas" ? "abertos" : view,
                });
              }}
              className={fieldClassName("h-8 w-auto max-w-[16rem] pr-8")}
            >
              <option value="">Todos os analistas</option>
              {(queues.data?.queues ?? []).map((x) => (
                <option key={x.user.id} value={x.user.id}>
                  {x.user.id === user?.id ? "Minha fila" : x.user.name} ({x.open})
                </option>
              ))}
              <option value="none">Sem analista ({queues.data?.unowned.open ?? 0})</option>
            </select>
          </label>
        ) : null}
      </div>

      {showFilters ? <FiltersCard id="chamados-filtros" view={view} filters={filters} onChange={update} /> : null}

      {anyFilter ? <ActiveFilters filters={filters} ownerName={ownerName} userId={user?.id} onChange={update} onClear={clear} /> : null}

      <Card className="overflow-hidden">
        <div ref={listTop} className="flex scroll-mt-20 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-2">
          <p className="min-w-0 text-xs text-ink-muted" role="status">
            {numberSearch && urlQ ? "Nº da OS: a busca olha todas as OS, em qualquer aba (inclusive as fechadas)." : null}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              <span className="text-xs font-semibold whitespace-nowrap text-ink/80">Ordenar por</span>
              <select
                value={order}
                onChange={(e) => writeListParams({ order_by: e.target.value, view })}
                className={fieldClassName("h-8 w-auto pr-8")}
              >
                {ORDERS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {/* No celular a lista já vira cartões: a densidade vale só para a tabela. */}
            <Button
              size="sm"
              variant="ghost"
              onClick={toggleDensity}
              aria-pressed={compact}
              title={compact ? "Voltar para a lista com mais detalhes" : "Uma linha por OS: mais OS na tela"}
              className="max-md:hidden"
            >
              {compact ? <Rows4 aria-hidden className="size-4" /> : <Rows3 aria-hidden className="size-4" />}
              Compacta
            </Button>
          </div>
        </div>

        {/* Página vazia de uma lista que encolheu: carrega enquanto vai para a última página com OS. */}
        {query.isLoading || (data && data.items.length === 0 && data.total > 0 && page > 1) ? (
          <LoadingBlock rows={6} />
        ) : !data ? (
          <div className="p-4">
            <ErrorBox message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
          </div>
        ) : data.items.length === 0 ? (
          <EmptyList
            view={view}
            q={urlQ}
            numberSearch={numberSearch}
            anyFilter={anyFilter}
            closedInOpenView={closedInOpenView}
            newHref={newHref}
            onClear={clear}
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
              <ul className="divide-y divide-line md:hidden" aria-label="Chamados">
                {data.items.map((t) => (
                  <li key={t.id}>
                    <TicketCard t={t} now={now} />
                  </li>
                ))}
              </ul>
              <div className="max-md:hidden">
                <Table label="Lista de chamados">
                  <thead>
                    <tr>
                      <Th>OS</Th>
                      <Th>Status</Th>
                      <Th>Agenda</Th>
                      <Th>Cliente / loja</Th>
                      <Th>Técnico</Th>
                      {manager ? <Th>Analista</Th> : null}
                      <Th>SLA</Th>
                      <Th className="hidden min-[1800px]:table-cell">Aberta em</Th>
                      {manager ? <Th edit>Editar</Th> : null}
                    </tr>
                  </thead>
                  {/* Linhas sem entrada animada: trocar de página ou filtro mostra o dado na hora. */}
                  <tbody>
                    {data.items.map((t) => (
                      <tr
                        key={t.id}
                        onClick={(e) => onRowClick(e, t)}
                        className={clsx("group cursor-pointer transition-colors hover:bg-[var(--row-hover)]", rowClass)}
                      >
                        <Td className="max-w-[22rem] min-w-[13rem] 2xl:min-w-[15rem]">
                          <TicketTitleCell t={t} compact={compact} />
                        </Td>
                        <Td>
                          <StatusCell t={t} />
                        </Td>
                        <Td>
                          <AgendaCell t={t} now={now} compact={compact} />
                        </Td>
                        <Td className="max-w-[11rem] 2xl:max-w-[14rem]">
                          <StoreCell t={t} />
                        </Td>
                        <Td className="max-w-[9.5rem] 2xl:max-w-[11rem]">
                          <TechnicianCell t={t} />
                        </Td>
                        {manager ? (
                          <Td>
                            <OwnerCell t={t} userId={user?.id} onClaim={(x) => void claimTicket(x)} claiming={claim.isPending} />
                          </Td>
                        ) : null}
                        <Td className="max-w-[11rem]">
                          <SlaCell t={t} now={now} compact={compact} />
                        </Td>
                        <Td
                          className="hidden text-xs whitespace-nowrap text-ink-subtle min-[1800px]:table-cell"
                          title={`Atualizada em ${formatDateTime(t.updated_at)}`}
                        >
                          {formatShort(t.created_at)}
                        </Td>
                        {manager ? (
                          <Td edit>
                            <QuickEditButton ticketId={t.id} code={t.code} />
                          </Td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm text-ink-muted">
              <span className="tabular-nums">
                {first.toLocaleString("pt-BR")}–{(first + data.items.length - 1).toLocaleString("pt-BR")} de {total.toLocaleString("pt-BR")}
              </span>
              <div className="flex gap-2">
                <Button size="sm" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                  <ChevronLeft aria-hidden className="size-4" />
                  Anterior
                </Button>
                <Button size="sm" disabled={page >= totalPages} onClick={() => goToPage(page + 1)}>
                  Próxima
                  <ChevronRight aria-hidden className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
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
