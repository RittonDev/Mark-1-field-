"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Hand, Plus, Search, SlidersHorizontal, TicketX, Users, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { PriorityBadge, SlaBadge, SlaCountdown, StatusBadge } from "@/components/badges";
import { MultiSelect } from "@/components/MultiSelect";
import { useToast } from "@/components/Toaster";
import { QuickEditButton } from "@/components/ticket/QuickEditButton";
import {
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Input,
  LoadingBlock,
  Select,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, isStaff, PRIORITY, PRIORITY_ORDER, STATUS, STATUS_ORDER } from "@/lib/constants";
import { formatShort } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useAssignable, useCustomers, useTeams } from "@/lib/queries";
import type { Page, TicketListItem } from "@/lib/types";

const PAGE_SIZE = 25;

interface Filters {
  status: string[];
  priority: string[];
  assignee_id: string;
  team_id: string;
  customer_id: string;
  asset_id: string;
  location_id: string;
  service_type_id: string;
  violation_pending: boolean;
  order_by: string;
}

// Visões rápidas (abas): a tela inicial é a lista de chamados, limpa, com o essencial à vista.
type View = "abertos" | "minhas" | "sem_responsavel" | "sla" | "todas";
const VIEWS: { key: View; label: string; staffOnly?: boolean }[] = [
  { key: "abertos", label: "Em aberto" },
  { key: "minhas", label: "Minhas", staffOnly: true },
  { key: "sem_responsavel", label: "Sem responsável", staffOnly: true },
  { key: "sla", label: "SLA violado", staffOnly: true },
  { key: "todas", label: "Todas" },
];
const VIEW_FLAGS: Record<View, Record<string, boolean>> = {
  abertos: { open_only: true },
  minhas: { mine: true, open_only: true },
  sem_responsavel: { unassigned: true, open_only: true },
  sla: { sla_breached: true },
  todas: {},
};

function initialView(params: URLSearchParams): View {
  if (params.get("sla_breached") === "true") return "sla";
  if (params.get("unassigned") === "true") return "sem_responsavel";
  if (params.get("mine") === "true") return "minhas";
  if (params.get("open_only") === "true") return "abertos";
  // Link com filtro específico (cliente, local, responsável...) mostra todas as OS daquele filtro.
  return [...params.keys()].some((k) => k !== "q") ? "todas" : "abertos";
}

function initialFilters(params: URLSearchParams): Filters {
  return {
    status: params.getAll("status"),
    priority: params.getAll("priority"),
    assignee_id: params.get("assignee_id") ?? "",
    team_id: params.get("team_id") ?? "",
    customer_id: params.get("customer_id") ?? "",
    asset_id: params.get("asset_id") ?? "",
    location_id: params.get("location_id") ?? "",
    service_type_id: params.get("service_type_id") ?? "",
    violation_pending: params.get("violation_pending") === "true",
    order_by: params.get("order_by") ?? "-updated_at",
  };
}

const EMPTY: Filters = initialFilters(new URLSearchParams());

function TicketsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const staff = isStaff(user?.role);
  const [filters, setFilters] = useState<Filters>(() => initialFilters(searchParams));
  const [view, setView] = useState<View>(() => initialView(searchParams));
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [page, setPage] = useState(1);
  const q = useDebounced(search.trim(), 350);

  const assignable = useAssignable(null, staff);
  const manager = canManageTickets(user?.role);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Puxar para si a OS de um colega (ou da fila): o analista assume na hora.
  const take = useMutation({
    mutationFn: (t: TicketListItem) => api.post(`/tickets/${t.id}/take`),
    onSuccess: (_, t) => {
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      toast({ title: `${t.code} agora é sua`, tone: "success" });
    },
    onError: (e) => toast({ title: "Não foi possível assumir", description: errorMessage(e), tone: "error" }),
  });
  const teams = useTeams();
  const customers = useCustomers();

  const query = useQuery({
    queryKey: ["tickets", "list", filters, view, q, page],
    queryFn: () =>
      api.get<Page<TicketListItem>>("/tickets", {
        ...filters,
        ...VIEW_FLAGS[view],
        q,
        page,
        page_size: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });

  const update = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const advancedCount =
    filters.status.length +
    filters.priority.length +
    [filters.assignee_id, filters.team_id, filters.customer_id].filter(Boolean).length +
    (filters.order_by !== "-updated_at" ? 1 : 0);
  const [showFilters, setShowFilters] = useState(() => advancedCount > 0);
  const hasFilters = JSON.stringify(filters) !== JSON.stringify(EMPTY) || search !== "";
  const clear = () => {
    setFilters(EMPTY);
    setSearch("");
    setPage(1);
    router.replace("/chamados");
  };
  const chooseView = (next: View) => {
    setView(next);
    setPage(1);
  };

  const data = query.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Chamados</h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            {data ? `${data.total} ordem(ns) de serviço` : "Ordens de serviço"}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-80 sm:flex-none">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-muted" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Buscar por número, título ou descrição"
              className="pl-9"
            />
          </div>
          <Button onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
            <SlidersHorizontal className="size-4" />
            Filtros
            {advancedCount > 0 ? (
              <span className="ml-0.5 rounded-full bg-brand px-1.5 text-[11px] font-semibold text-white">
                {advancedCount}
              </span>
            ) : null}
          </Button>
          <Link href="/chamados/novo">
            <Button variant="primary">
              <Plus className="size-4" />
              Nova OS
            </Button>
          </Link>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line">
      <div className="-mb-px flex gap-1 overflow-x-auto overflow-y-hidden">
        {VIEWS.filter((v) => staff || !v.staffOnly).map((v) => {
          const active = view === v.key;
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => chooseView(v.key)}
              className={`relative px-3 pt-1 pb-2.5 text-sm whitespace-nowrap transition-colors ${
                active ? "font-medium text-ink" : "text-ink-muted hover:text-ink"
              }`}
            >
              {v.label}
              {active ? <span className="brand-gradient absolute inset-x-2 bottom-0 h-0.5 rounded-full" /> : null}
            </button>
          );
        })}
      </div>
        {manager ? (
          // Fila de um colega: para ver o que está com ele e, se preciso, puxar a OS para si.
          <label className="mb-1.5 flex items-center gap-2 text-sm text-ink-muted">
            <Users className="size-4" />
            <span className="whitespace-nowrap">Fila de</span>
            <select
              value={filters.assignee_id}
              onChange={(e) => {
                if (view === "minhas" || view === "sem_responsavel") setView("abertos");
                update({ assignee_id: e.target.value });
              }}
              className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink"
              aria-label="Fila de"
            >
              <option value="">Todos</option>
              {(assignable.data ?? [])
                .filter((u) => u.id !== user?.id)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.open_tickets})
                  </option>
                ))}
            </select>
          </label>
        ) : null}
      </div>

      {showFilters ? (
        <Card className="mb-4 p-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
            <MultiSelect
              label="Status"
              value={filters.status}
              onChange={(status) => update({ status })}
              options={STATUS_ORDER.map((s) => ({ value: s, label: STATUS[s].label, color: STATUS[s].color }))}
            />
            <MultiSelect
              label="Prioridade"
              value={filters.priority}
              onChange={(priority) => update({ priority })}
              options={PRIORITY_ORDER.map((p) => ({
                value: p,
                label: `${PRIORITY[p].code} · ${PRIORITY[p].label}`,
                color: PRIORITY[p].color,
              }))}
            />
            {staff ? (
              <>
                <Select value={filters.assignee_id} onChange={(e) => update({ assignee_id: e.target.value })}>
                  <option value="">Todos os responsáveis</option>
                  {assignable.data?.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
                <Select value={filters.team_id} onChange={(e) => update({ team_id: e.target.value })}>
                  <option value="">Todos os grupos</option>
                  {teams.data?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
                <Select value={filters.customer_id} onChange={(e) => update({ customer_id: e.target.value })}>
                  <option value="">Todos os clientes</option>
                  {customers.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </>
            ) : null}
            <Select value={filters.order_by} onChange={(e) => update({ order_by: e.target.value })}>
              <option value="-updated_at">Atualizados recentemente</option>
              <option value="-created_at">Mais novos</option>
              <option value="created_at">Mais antigos</option>
              <option value="priority">Maior prioridade</option>
              <option value="resolution_due_at">Prazo de solução mais próximo</option>
              <option value="-number">Número (desc.)</option>
            </Select>
          </div>
        </Card>
      ) : null}

      {filters.asset_id || filters.location_id || filters.violation_pending || filters.service_type_id || hasFilters ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {filters.asset_id ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2.5 py-1 text-xs text-brand">
              Filtrando por equipamento
              <button type="button" onClick={() => update({ asset_id: "" })} aria-label="Remover filtro">
                <X className="size-3" />
              </button>
            </span>
          ) : null}
          {filters.location_id ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2.5 py-1 text-xs text-brand">
              Filtrando por local
              <button type="button" onClick={() => update({ location_id: "" })} aria-label="Remover filtro">
                <X className="size-3" />
              </button>
            </span>
          ) : null}
          {filters.violation_pending ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-300">
              Pendentes de justificativa de SLA
              <button type="button" onClick={() => update({ violation_pending: false })} aria-label="Remover filtro">
                <X className="size-3" />
              </button>
            </span>
          ) : null}
          {filters.service_type_id ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2.5 py-1 text-xs text-brand">
              Filtrando por tipo de serviço
              <button type="button" onClick={() => update({ service_type_id: "" })} aria-label="Remover filtro">
                <X className="size-3" />
              </button>
            </span>
          ) : null}
          {hasFilters ? (
            <Button variant="ghost" size="sm" onClick={clear}>
              <X className="size-3.5" />
              Limpar filtros
            </Button>
          ) : null}
        </div>
      ) : null}

      <Card>
        {query.isLoading ? (
          <LoadingBlock />
        ) : query.error ? (
          <div className="p-4">
            <ErrorBox message={errorMessage(query.error)} />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            icon={<TicketX className="size-8" />}
            title="Nenhum chamado encontrado"
            description="Ajuste os filtros ou abra uma nova ordem de serviço."
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>OS</Th>
                  <Th>Status</Th>
                  <Th>Prioridade</Th>
                  <Th>Cliente / local</Th>
                  <Th>Responsável</Th>
                  <Th>SLA</Th>
                  <Th>Atualizado</Th>
                </tr>
              </thead>
              <tbody className={query.isFetching ? "opacity-70" : undefined}>
                {data.items.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => router.push(`/chamados/${t.id}`)}
                    className="cursor-pointer hover:bg-surface-2"
                  >
                    <Td className="max-w-[22rem]">
                      <div className="flex items-start gap-1">
                        <Link
                          href={`/chamados/${t.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="block min-w-0 flex-1 font-medium text-ink hover:text-brand"
                        >
                          <span className="mr-1.5 font-mono text-xs text-ink-muted">{t.code}</span>
                          {t.title}
                        </Link>
                        {manager ? (
                          <span className="-my-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                            <QuickEditButton ticketId={t.id} code={t.code} />
                          </span>
                        ) : null}
                      </div>
                      {t.category ? (
                        <span className="mt-0.5 block truncate text-xs text-ink-muted">{t.category.full_name}</span>
                      ) : null}
                    </Td>
                    <Td>
                      <StatusBadge status={t.status} />
                    </Td>
                    <Td>
                      <PriorityBadge priority={t.priority} compact />
                    </Td>
                    <Td className="max-w-[14rem]">
                      <span className="block truncate">{t.customer?.name ?? t.requester_name ?? "—"}</span>
                      {t.location ? (
                        <span className="block truncate text-xs text-ink-muted">
                          {t.location.name}
                          {t.location.city ? ` · ${t.location.city}` : ""}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1">
                        {t.assignee ? (
                          <span className="whitespace-nowrap">{t.assignee.name}</span>
                        ) : (
                          <span className="text-xs text-amber-600 dark:text-amber-400">Sem responsável</span>
                        )}
                        {manager && t.assignee?.id !== user?.id && !STATUS[t.status].final ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              take.mutate(t);
                            }}
                            disabled={take.isPending}
                            className="-my-1 shrink-0 rounded-md p-1 text-ink-muted hover:bg-surface-2 hover:text-brand disabled:opacity-50"
                            aria-label={`Puxar ${t.code} para mim`}
                            title={t.assignee ? `Puxar de ${t.assignee.name} para mim` : "Assumir esta OS"}
                          >
                            <Hand className="size-3.5" />
                          </button>
                        ) : null}
                      </div>
                      {t.team ? <span className="block text-xs text-ink-muted">{t.team.name}</span> : null}
                    </Td>
                    <Td>
                      <div className="flex flex-col items-start gap-1">
                        <SlaBadge status={t.sla_status} />
                        <SlaCountdown ticket={t} />
                      </div>
                    </Td>
                    <Td className="text-xs whitespace-nowrap text-ink-muted">{formatShort(t.updated_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between px-4 py-3 text-sm text-ink-muted">
              <span>
                Página {data.page} de {totalPages} · {data.total} registro(s)
              </span>
              <div className="flex gap-2">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="size-4" />
                  Anterior
                </Button>
                <Button size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Próxima
                  <ChevronRight className="size-4" />
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
