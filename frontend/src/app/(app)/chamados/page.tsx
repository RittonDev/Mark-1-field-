"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, Hand, Plus, Search, SlidersHorizontal, TicketX, Users, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { PriorityBadge, SlaBadge, SlaCountdown, StatusBadge } from "@/components/badges";
import { Tabs } from "@/components/motion";
import { MultiSelect } from "@/components/MultiSelect";
import { useToast } from "@/components/Toaster";
import { QuickEditButton } from "@/components/ticket/QuickEditButton";
import { ArrivalChip, AuthorizationChip, OnsiteBar, RecurrenceChip } from "@/components/ticket/FieldClock";
import { TagChips } from "@/components/TagChips";
import {
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, isStaff, PRIORITY, PRIORITY_ORDER, STATUS, STATUS_ORDER } from "@/lib/constants";
import { formatShort, initials } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useAssignable, useCustomers, useTeams } from "@/lib/queries";
import type { Page, QueuesOut, TicketListItem } from "@/lib/types";

const PAGE_SIZE = 25;

interface Filters {
  status: string[];
  priority: string[];
  assignee_id: string;
  owner_id: string;
  no_owner: boolean;
  team_id: string;
  customer_id: string;
  asset_id: string;
  location_id: string;
  service_type_id: string;
  violation_pending: boolean;
  order_by: string;
}

// Visões rápidas (abas): a tela de chamados limpa, com o essencial à vista.
type View = "abertos" | "minhas" | "sem_responsavel" | "sla" | "todas";
const VIEWS: { key: View; label: string; staffOnly?: boolean }[] = [
  { key: "abertos", label: "Em aberto" },
  { key: "minhas", label: "Minhas", staffOnly: true },
  { key: "sem_responsavel", label: "Sem atribuição", staffOnly: true },
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
  // Fila de um analista (ou sem analista): mostra as abertas dela.
  if (params.get("owner_id") || params.get("no_owner") === "true") return "abertos";
  // Link com filtro específico (cliente, local, responsável...) mostra todas as OS daquele filtro.
  return [...params.keys()].some((k) => k !== "q") ? "todas" : "abertos";
}

function initialFilters(params: URLSearchParams): Filters {
  return {
    status: params.getAll("status"),
    priority: params.getAll("priority"),
    assignee_id: params.get("assignee_id") ?? "",
    owner_id: params.get("owner_id") ?? "",
    no_owner: params.get("no_owner") === "true",
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

function Chip({ children, onClear, tone = "brand" }: { children: React.ReactNode; onClear: () => void; tone?: "brand" | "amber" }) {
  return (
    <span
      className={clsx(
        "inline-flex animate-enter items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium",
        tone === "brand" ? "bg-brand-soft text-brand-ink" : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
    >
      {children}
      <button type="button" onClick={onClear} aria-label="Remover filtro" className="rounded-full p-0.5 hover:bg-black/5">
        <X className="size-3" />
      </button>
    </span>
  );
}

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
  // Filas dos analistas (quem acompanha cada OS), com quantas estão abertas.
  const queues = useQuery({
    queryKey: ["tickets", "queues"],
    queryFn: () => api.get<QueuesOut>("/queues"),
    enabled: manager,
    staleTime: 30_000,
  });
  // Assumir: a OS vai para a fila de quem assumiu (o técnico continua o mesmo).
  const claim = useMutation({
    mutationFn: (t: TicketListItem) => api.post(`/tickets/${t.id}/claim`),
    onSuccess: (_, t) => {
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      queryClient.invalidateQueries({ queryKey: ["ticket", t.id] });
      toast({ title: `Você assumiu a ${t.code}: está na sua fila`, tone: "success" });
    },
    onError: (e) => toast({ title: "Não foi possível assumir a OS", description: errorMessage(e), tone: "error" }),
  });
  const teams = useTeams();
  const customers = useCustomers();

  const query = useQuery({
    queryKey: ["tickets", "list", filters, view, q, page],
    queryFn: () =>
      api.get<Page<TicketListItem>>("/tickets", {
        ...filters,
        owner_id: filters.owner_id || undefined,
        no_owner: filters.no_owner || undefined,
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
  const queueValue = filters.no_owner ? "none" : filters.owner_id;
  const ownerName = queues.data?.queues.find((x) => x.user.id === filters.owner_id)?.user.name;

  const data = query.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Chamados"
        description={data ? `${data.total} ordem(ns) de serviço` : "Ordens de serviço"}
        actions={
          <>
            <div className="relative min-w-0 flex-1 sm:w-80 sm:flex-none">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-subtle" />
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
                <span className="ml-0.5 rounded-full bg-brand px-1.5 text-[11px] font-semibold text-white">{advancedCount}</span>
              ) : null}
            </Button>
            <Link href="/chamados/novo">
              <Button variant="primary">
                <Plus className="size-4" />
                Nova OS
              </Button>
            </Link>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line">
        <Tabs
          className="-mb-px"
          items={VIEWS.filter((v) => staff || !v.staffOnly)}
          value={view}
          onChange={chooseView}
          ariaLabel="Visões dos chamados"
        />
        {manager ? (
          // Fila de um analista: para ver o que está com ele e, se preciso, puxar a OS para si.
          <label className="mb-1.5 flex items-center gap-2 text-sm text-ink-muted">
            <Users className="size-4 text-ink-subtle" />
            <span className="whitespace-nowrap">Fila de</span>
            <select
              value={queueValue}
              onChange={(e) => {
                const value = e.target.value;
                if (view === "minhas") setView("abertos");
                update({ owner_id: value === "none" ? "" : value, no_owner: value === "none" });
              }}
              className="h-8 rounded-lg border border-line bg-surface px-2.5 pr-8 text-sm text-ink shadow-elev-1"
              aria-label="Fila de"
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

      {showFilters ? (
        <Card className="mb-4 animate-enter p-3">
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
                  <option value="">Atribuídas a qualquer um</option>
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
          {filters.owner_id ? (
            <Chip onClear={() => update({ owner_id: "" })}>
              Fila de {filters.owner_id === user?.id ? "você" : (ownerName ?? "um analista")}
            </Chip>
          ) : null}
          {filters.no_owner ? <Chip onClear={() => update({ no_owner: false })}>Sem analista responsável</Chip> : null}
          {filters.asset_id ? <Chip onClear={() => update({ asset_id: "" })}>Filtrando por equipamento</Chip> : null}
          {filters.location_id ? <Chip onClear={() => update({ location_id: "" })}>Filtrando por local</Chip> : null}
          {filters.violation_pending ? (
            <Chip tone="amber" onClear={() => update({ violation_pending: false })}>
              Pendentes de justificativa de SLA
            </Chip>
          ) : null}
          {filters.service_type_id ? (
            <Chip onClear={() => update({ service_type_id: "" })}>Filtrando por tipo de serviço</Chip>
          ) : null}
          {hasFilters ? (
            <Button variant="ghost" size="sm" onClick={clear}>
              <X className="size-3.5" />
              Limpar filtros
            </Button>
          ) : null}
        </div>
      ) : null}

      <Card className="overflow-hidden">
        {query.isLoading ? (
          <LoadingBlock rows={5} />
        ) : query.error ? (
          <div className="p-4">
            <ErrorBox message={errorMessage(query.error)} />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            icon={<TicketX />}
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
                  <Th>Cliente / local</Th>
                  <Th>Atribuída a</Th>
                  {manager ? <Th>Analista</Th> : null}
                  <Th>SLA</Th>
                  <Th className="hidden 2xl:table-cell">Atualizado</Th>
                  {manager ? <Th className="edit-col">Editar</Th> : null}
                </tr>
              </thead>
              <tbody className={clsx("stagger transition-opacity", query.isFetching && "opacity-70")}>
                {data.items.map((t, index) => {
                  const open = ["open", "active", "pending"].includes(STATUS[t.status].group);
                  const owner = t.owner ?? null;
                  return (
                    <tr
                      key={t.id}
                      style={{ ["--i" as string]: index }}
                      onClick={() => router.push(`/chamados/${t.id}`)}
                      className="group cursor-pointer transition-colors hover:bg-[var(--row-hover)]"
                    >
                      <Td className="max-w-[20rem]">
                        <Link
                          href={`/chamados/${t.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="block font-medium text-ink hover:text-brand"
                        >
                          <span className="mr-1.5 font-mono text-xs font-normal text-ink-subtle">{t.code}</span>
                          {t.title}
                        </Link>
                        {t.category ? <span className="mt-0.5 block truncate text-xs text-ink-subtle">{t.category.full_name}</span> : null}
                        {t.authorization_status === "pending" || t.authorization_status === "denied" || t.recurrence_30d || t.tags?.length ? (
                          <span className="mt-1.5 flex flex-wrap gap-1">
                            <AuthorizationChip status={t.authorization_status} hideAuthorized />
                            <RecurrenceChip count={t.recurrence_30d} />
                            <TagChips tags={t.tags} max={2} />
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge status={t.status} />
                          <PriorityBadge priority={t.priority} compact />
                        </div>
                      </Td>
                      <Td className="max-w-[12rem]">
                        <span className="block truncate">{t.customer?.name ?? t.requester_name ?? "—"}</span>
                        {t.location ? (
                          <span className="block truncate text-xs text-ink-subtle">
                            {t.location.name}
                            {t.location.city ? ` · ${t.location.city}` : ""}
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        {t.assignee ? (
                          <span className="whitespace-nowrap">
                            {t.assignee.name}
                            {t.assignee.is_active === false ? (
                              <span
                                className="ml-1.5 rounded-full bg-red-50 px-1.5 py-px text-[11px] font-medium text-red-700 dark:bg-red-500/10 dark:text-red-300"
                                title="Técnico desativado: não entra no app. Reatribua a OS."
                              >
                                inativo
                              </span>
                            ) : null}
                            {t.helpers?.length ? (
                              <span
                                className="ml-1.5 rounded-full bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200"
                                title={`Junto: ${t.helpers.map((h) => h.name).join(", ")}`}
                              >
                                +{t.helpers.length}
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Sem atribuição</span>
                        )}
                        {t.team ? <span className="block text-xs text-ink-subtle">{t.team.name}</span> : null}
                      </Td>
                      {manager ? (
                        <Td>
                          <div className="flex items-center gap-1.5">
                            {owner ? (
                              <>
                                <span
                                  className={clsx(
                                    "flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                                    owner.id === user?.id ? "bg-brand text-white" : "bg-surface-3 text-ink-muted",
                                  )}
                                  title={owner.name}
                                >
                                  {initials(owner.name)}
                                </span>
                                <span className="max-w-[8rem] truncate text-xs text-ink-muted">
                                  {owner.id === user?.id ? "Você" : owner.name.split(" ")[0]}
                                </span>
                              </>
                            ) : (
                              <span className="text-xs text-ink-subtle">—</span>
                            )}
                            {open && owner?.id !== user?.id ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  claim.mutate(t);
                                }}
                                disabled={claim.isPending}
                                className="-my-1 shrink-0 rounded-md p-1 text-ink-subtle opacity-60 transition-[opacity,color,background-color] group-hover:opacity-100 hover:bg-surface-3 hover:text-brand disabled:opacity-40"
                                aria-label={`Assumir ${t.code}`}
                                title={owner ? `Assumir OS: sai da fila de ${owner.name} e vai para a sua` : "Assumir OS: vai para a sua fila"}
                              >
                                <Hand className="size-3.5" />
                              </button>
                            ) : null}
                          </div>
                        </Td>
                      ) : null}
                      <Td>
                        <div className="flex flex-col items-start gap-1">
                          <SlaBadge status={t.sla_status} />
                          <SlaCountdown ticket={t} />
                          {open && !t.arrived_at ? <ArrivalChip ticket={t} compact /> : null}
                          {t.status === "in_progress" ? <OnsiteBar ticket={t} className="mt-0.5" /> : null}
                        </div>
                      </Td>
                      <Td className="hidden text-xs whitespace-nowrap text-ink-subtle 2xl:table-cell">{formatShort(t.updated_at)}</Td>
                      {manager ? (
                        <Td className="edit-col">
                          <QuickEditButton ticketId={t.id} code={t.code} />
                        </Td>
                      ) : null}
                    </tr>
                  );
                })}
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
