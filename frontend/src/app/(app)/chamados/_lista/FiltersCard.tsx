"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { useId, useMemo } from "react";
import { LocationPicker } from "@/components/LocationPicker";
import { MultiSelect } from "@/components/MultiSelect";
import { CustomerPicker } from "@/components/new-ticket/CustomerPicker";
import { ServiceTypePicker } from "@/components/new-ticket/ServiceTypePicker";
import { Card, Field, Select, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { PRIORITY, PRIORITY_ORDER, ROLE, STATUS, STATUS_ORDER, TICKET_TYPE } from "@/lib/constants";
import { useProjects } from "@/lib/projects";
import { useAssignable, useCategories, useCustomers, useServiceTypes, useTeams } from "@/lib/queries";
import type { Location, TicketPriority, TicketSource, TicketStatus, TicketType } from "@/lib/types";
import { type Filters, isOpenStatus, SOURCES, type View } from "./params";

/** A loja do filtro (a URL guarda só o id): o nome no chip e o valor da busca de loja. */
export function useFilterLocation(locationId: string) {
  return useQuery({
    queryKey: ["location", locationId],
    queryFn: () => api.get<Location>(`/locations/${locationId}`),
    enabled: Boolean(locationId),
    staleTime: 60_000,
  });
}

/** Rótulo de um campo que não fica dentro de <label> (lista com busca, escolha múltipla). */
function FilterField({ label, labelId, className, children }: { label: string; labelId: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={clsx("flex min-w-0 flex-col gap-1.5", className)}>
      <span id={labelId} className="text-xs font-semibold text-ink/80">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Filtros da lista. Os cadastros (técnicos, clientes, tipos de serviço...) só carregam com o cartão
 * aberto. Nas abas de OS em aberto, o status oferece só os status em aberto.
 */
export function FiltersCard({
  id,
  view,
  filters,
  onChange,
}: {
  id?: string;
  view: View;
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
}) {
  const ids = { status: useId(), priority: useId(), customer: useId(), store: useId(), serviceType: useId() };
  const assignable = useAssignable(null);
  const teams = useTeams();
  const customers = useCustomers();
  const serviceTypes = useServiceTypes();
  const categories = useCategories();
  const projects = useProjects();
  const location = useFilterLocation(filters.location_id);
  const openOnly = view !== "todas";

  // Técnicos primeiro (quem vai a campo), depois o resto da equipe.
  const people = useMemo(
    () =>
      [...(assignable.data ?? [])].sort(
        (a, b) => (a.role === "technician" ? 0 : 1) - (b.role === "technician" ? 0 : 1) || a.name.localeCompare(b.name, "pt-BR"),
      ),
    [assignable.data],
  );
  const categoryOptions = useMemo(
    () =>
      (categories.data ?? [])
        .filter((c) => c.is_active || c.id === filters.category_id)
        .sort((a, b) => a.full_name.localeCompare(b.full_name, "pt-BR")),
    [categories.data, filters.category_id],
  );
  const projectOptions = projects.data ?? [];
  const serviceType = serviceTypes.data?.find((t) => t.id === filters.service_type_id) ?? null;

  return (
    <Card className="mb-4 animate-enter p-4">
      <div id={id} className="grid gap-x-3 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <FilterField label="Status" labelId={ids.status}>
          <MultiSelect
            label="Status"
            ariaLabel="Status"
            value={filters.status}
            onChange={(status) => onChange({ status: status as TicketStatus[] })}
            options={STATUS_ORDER.filter((s) => !openOnly || isOpenStatus(s)).map((s) => ({
              value: s,
              label: STATUS[s].label,
              color: STATUS[s].color,
            }))}
          />
        </FilterField>
        <FilterField label="Prioridade" labelId={ids.priority}>
          <MultiSelect
            label="Prioridade"
            ariaLabel="Prioridade"
            value={filters.priority}
            onChange={(priority) => onChange({ priority: priority as TicketPriority[] })}
            options={PRIORITY_ORDER.map((p) => ({ value: p, label: `${PRIORITY[p].code} · ${PRIORITY[p].label}`, color: PRIORITY[p].color }))}
          />
        </FilterField>
        <Field label="Tipo de atendimento">
          <Select value={filters.type} onChange={(e) => onChange({ type: e.target.value as TicketType | "" })}>
            <option value="">Todos</option>
            {(Object.keys(TICKET_TYPE) as TicketType[]).map((type) => (
              <option key={type} value={type}>
                {TICKET_TYPE[type]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Origem">
          <Select value={filters.source} onChange={(e) => onChange({ source: e.target.value as TicketSource | "" })}>
            <option value="">Todas</option>
            {SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>

        <FilterField label="Cliente" labelId={ids.customer}>
          <CustomerPicker
            customers={customers.data}
            loading={customers.isLoading}
            includeInactive
            value={filters.customer_id}
            labelledBy={ids.customer}
            placeholder="Todos os clientes"
            onChange={(c) => {
              const customerId = c?.id ?? "";
              // Loja de outro cliente não combina com o cliente novo: sai do filtro.
              const store = location.data;
              const dropStore = Boolean(customerId && store && store.customer_id !== customerId);
              onChange(dropStore ? { customer_id: customerId, location_id: "" } : { customer_id: customerId });
            }}
          />
        </FilterField>
        <FilterField label="Loja" labelId={ids.store} className="lg:col-span-2">
          {filters.location_id && location.isLoading ? (
            <Skeleton className="h-9 w-full rounded-lg" />
          ) : (
            <LocationPicker
              customerId={filters.customer_id || null}
              customerName={customers.data?.find((c) => c.id === filters.customer_id)?.name ?? null}
              onClearCustomer={() => onChange({ customer_id: "" })}
              value={filters.location_id ? (location.data ?? null) : null}
              onChange={(loc) => onChange({ location_id: loc?.id ?? "" })}
              labelledBy={ids.store}
            />
          )}
        </FilterField>
        <FilterField label="Tipo de serviço" labelId={ids.serviceType}>
          <ServiceTypePicker
            types={serviceTypes.data}
            loading={serviceTypes.isLoading}
            value={serviceType}
            customerId={filters.customer_id || null}
            labelledBy={ids.serviceType}
            placeholder="Todos os tipos"
            onChange={(type) => onChange({ service_type_id: type?.id ?? "" })}
          />
        </FilterField>

        <Field label="Técnico">
          <Select value={filters.assignee_id} onChange={(e) => onChange({ assignee_id: e.target.value })}>
            <option value="">Qualquer técnico</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
                {u.role === "technician" ? "" : ` (${ROLE[u.role].toLowerCase()})`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Grupo">
          <Select value={filters.team_id} onChange={(e) => onChange({ team_id: e.target.value })}>
            <option value="">Todos os grupos</option>
            {(teams.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Categoria">
          <Select value={filters.category_id} onChange={(e) => onChange({ category_id: e.target.value })}>
            <option value="">Todas as categorias</option>
            {categoryOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.full_name}
              </option>
            ))}
          </Select>
        </Field>
        {projectOptions.length || filters.project_id ? (
          <Field label="Projeto">
            <Select value={filters.project_id} onChange={(e) => onChange({ project_id: e.target.value })}>
              <option value="">Com ou sem projeto</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
    </Card>
  );
}
