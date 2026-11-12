"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, Search, TicketX, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { PriorityBadge, SlaBadge, SlaCountdown, StatusBadge } from "@/components/badges";
import { MultiSelect } from "@/components/MultiSelect";
import {
  Button,
  Card,
  Checkbox,
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
import { isStaff, PRIORITY, PRIORITY_ORDER, STATUS, STATUS_ORDER } from "@/lib/constants";
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
  mine: boolean;
  unassigned: boolean;
  sla_breached: boolean;
  open_only: boolean;
  order_by: string;
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
    mine: params.get("mine") === "true",
    unassigned: params.get("unassigned") === "true",
    sla_breached: params.get("sla_breached") === "true",
    open_only: params.get("open_only") === "true",
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
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [page, setPage] = useState(1);
  const q = useDebounced(search.trim(), 350);

  const assignable = useAssignable(null, staff);
  const teams = useTeams();
  const customers = useCustomers();

  const query = useQuery({
    queryKey: ["tickets", "list", filters, q, page],
    queryFn: () =>
      api.get<Page<TicketListItem>>("/tickets", {
        ...filters,
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
  const hasFilters = JSON.stringify(filters) !== JSON.stringify(EMPTY) || search !== "";
  const clear = () => {
    setFilters(EMPTY);
    setSearch("");
    setPage(1);
    router.replace("/chamados");
  };

  const data = query.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Chamados"
        description={data ? `${data.total} ordem(ns) de serviço encontrada(s)` : "Ordens de serviço"}
        actions={
          <Link href="/chamados/novo">
            <Button variant="primary">
              <Plus className="size-4" />
              Nova OS
            </Button>
          </Link>
        }
      />

      <Card className="mb-4 p-3">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <div className="relative col-span-2 md:col-span-3 xl:col-span-2">
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
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          {staff ? (
            <>
              <Checkbox label="Minhas OS" checked={filters.mine} onChange={(mine) => update({ mine })} />
              <Checkbox
                label="Sem responsável"
                checked={filters.unassigned}
                onChange={(unassigned) => update({ unassigned })}
              />
              <Checkbox
                label="SLA violado"
                checked={filters.sla_breached}
                onChange={(sla_breached) => update({ sla_breached })}
              />
            </>
          ) : null}
          <Checkbox
            label="Somente em aberto"
            checked={filters.open_only}
            onChange={(open_only) => update({ open_only })}
          />
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
          {filters.service_type_id ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2.5 py-1 text-xs text-brand">
              Filtrando por tipo de serviço
              <button type="button" onClick={() => update({ service_type_id: "" })} aria-label="Remover filtro">
                <X className="size-3" />
              </button>
            </span>
          ) : null}
          {hasFilters ? (
            <Button variant="ghost" size="sm" onClick={clear} className="ml-auto">
              <X className="size-3.5" />
              Limpar filtros
            </Button>
          ) : null}
        </div>
      </Card>

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
                      <Link
                        href={`/chamados/${t.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="block font-medium text-ink hover:text-brand"
                      >
                        <span className="mr-1.5 font-mono text-xs text-ink-muted">{t.code}</span>
                        {t.title}
                      </Link>
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
                      {t.assignee ? (
                        <span className="whitespace-nowrap">{t.assignee.name}</span>
                      ) : (
                        <span className="text-xs text-amber-600 dark:text-amber-400">Sem responsável</span>
                      )}
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
