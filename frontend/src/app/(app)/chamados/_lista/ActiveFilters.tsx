"use client";

import clsx from "clsx";
import { X } from "lucide-react";
import { Button } from "@/components/ui";
import { PRIORITY, STATUS, TICKET_TYPE } from "@/lib/constants";
import { useProjects } from "@/lib/projects";
import { useAssignable, useCategories, useCustomers, useServiceTypes, useTeams } from "@/lib/queries";
import type { UUID } from "@/lib/types";
import { rangeLabel } from "./DateRange";
import { nameOr, useFilterLocation } from "./FilterBar";
import { type Filters, SOURCES } from "./params";

function Chip({ label, onClear, tone = "brand" }: { label: string; onClear: () => void; tone?: "brand" | "amber" | "neutral" }) {
  return (
    <span
      className={clsx(
        "inline-flex max-w-full animate-enter items-center gap-1 rounded-full py-1 pr-1 pl-2.5 text-xs font-medium",
        tone === "brand" && "bg-brand-soft text-brand-ink",
        tone === "amber" && "bg-amber-500/10 text-amber-800 dark:text-amber-300",
        tone === "neutral" && "bg-surface-2 text-ink-muted ring-1 ring-line ring-inset",
      )}
    >
      <span className="truncate" title={label}>
        {label}
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remover: ${label}`}
        title="Remover"
        className="shrink-0 rounded-full p-0.5 transition-colors hover:bg-ink/10 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
      >
        <X aria-hidden className="size-3" />
      </button>
    </span>
  );
}

// Cada chip de cadastro busca o nome só quando aparece (o cadastro já costuma estar em cache).

function TechnicianChip({ id, onClear, prefix = "Técnico" }: { id: UUID; onClear: () => void; prefix?: string }) {
  const people = useAssignable(null);
  return <Chip label={`${prefix}: ${nameOr(people.data?.find((u) => u.id === id)?.name, people.isLoading)}`} onClear={onClear} />;
}

function TeamChip({ id, onClear }: { id: UUID; onClear: () => void }) {
  const teams = useTeams();
  return <Chip label={`Grupo: ${nameOr(teams.data?.find((t) => t.id === id)?.name, teams.isLoading)}`} onClear={onClear} />;
}

function CustomerChip({ id, onClear }: { id: UUID; onClear: () => void }) {
  const customers = useCustomers();
  return <Chip label={`Cliente: ${nameOr(customers.data?.find((c) => c.id === id)?.name, customers.isLoading)}`} onClear={onClear} />;
}

function LocationChip({ id, onClear }: { id: UUID; onClear: () => void }) {
  const location = useFilterLocation(id);
  const l = location.data;
  const name = l ? [l.code && !l.name.includes(l.code) ? l.code : null, l.name].filter(Boolean).join(" · ") : undefined;
  return <Chip label={`Localização: ${nameOr(name, location.isLoading)}`} onClear={onClear} />;
}

function ServiceTypeChip({ id, onClear }: { id: UUID; onClear: () => void }) {
  const types = useServiceTypes();
  return <Chip label={`Tipo de OS: ${nameOr(types.data?.find((t) => t.id === id)?.name, types.isLoading)}`} onClear={onClear} />;
}

function CategoryChip({ id, onClear }: { id: UUID; onClear: () => void }) {
  const categories = useCategories();
  return <Chip label={`Categoria: ${nameOr(categories.data?.find((c) => c.id === id)?.full_name, categories.isLoading)}`} onClear={onClear} />;
}

function ProjectChip({ id, onClear }: { id: UUID; onClear: () => void }) {
  const projects = useProjects();
  const p = projects.data?.find((x) => x.id === id);
  return <Chip label={`Projeto: ${nameOr(p ? `${p.code} · ${p.name}` : undefined, projects.isLoading)}`} onClear={onClear} />;
}

/**
 * Filtros em uso, sempre à vista, cada um com o nome e o × que o tira, e a ordem da lista quando a
 * coluna dela não está na tabela. "Limpar filtros" tira todos e a busca.
 */
export function ActiveFilters({
  filters: f,
  ownerName,
  userId,
  orderLabel,
  onChange,
  onResetOrder,
  onClear,
}: {
  filters: Filters;
  /** Nome do analista da fila escolhida. */
  ownerName: string | undefined;
  userId: UUID | undefined;
  /** Ordem que não aparece em nenhum cabeçalho à vista (ex.: "Atualizadas recentemente"). */
  orderLabel: string | null;
  onChange: (patch: Partial<Filters>) => void;
  onResetOrder: () => void;
  /** Tira todos os filtros e a busca (null: nenhum filtro em uso, o botão não aparece). */
  onClear: (() => void) | null;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filtros em uso">
      {f.number !== null ? <Chip label={`Identificador: ${f.number}`} onClear={() => onChange({ number: null })} /> : null}
      {f.owner_id ? (
        <Chip
          label={f.owner_id === userId ? "Minha fila" : `Fila de ${ownerName ?? "um analista"}`}
          onClear={() => onChange({ owner_id: "" })}
        />
      ) : null}
      {f.no_owner ? <Chip label="Sem analista" onClear={() => onChange({ no_owner: false })} /> : null}
      {f.violation_pending ? (
        <Chip tone="amber" label="SLA violado sem justificativa" onClear={() => onChange({ violation_pending: false })} />
      ) : null}
      {f.status.map((s) => (
        <Chip key={s} label={`Situação: ${STATUS[s].label}`} onClear={() => onChange({ status: f.status.filter((x) => x !== s) })} />
      ))}
      {f.customer_id ? <CustomerChip id={f.customer_id} onClear={() => onChange({ customer_id: "" })} /> : null}
      {f.location_id ? <LocationChip id={f.location_id} onClear={() => onChange({ location_id: "" })} /> : null}
      {f.created_from || f.created_to ? (
        <Chip
          label={`Criação: ${rangeLabel({ from: f.created_from, to: f.created_to })}`}
          onClear={() => onChange({ created_from: "", created_to: "" })}
        />
      ) : null}
      {f.technician_id ? (
        <TechnicianChip id={f.technician_id} prefix="Técnico que atuou" onClear={() => onChange({ technician_id: "" })} />
      ) : null}
      {f.assignee_id ? <TechnicianChip id={f.assignee_id} onClear={() => onChange({ assignee_id: "" })} /> : null}
      {f.service_type_id ? <ServiceTypeChip id={f.service_type_id} onClear={() => onChange({ service_type_id: "" })} /> : null}
      {f.tag.map((name) => (
        <Chip key={name} label={`Etiqueta: ${name}`} onClear={() => onChange({ tag: f.tag.filter((x) => x !== name) })} />
      ))}
      {f.priority.map((p) => (
        <Chip
          key={p}
          label={`${PRIORITY[p].code} · ${PRIORITY[p].label}`}
          onClear={() => onChange({ priority: f.priority.filter((x) => x !== p) })}
        />
      ))}
      {f.project_id ? <ProjectChip id={f.project_id} onClear={() => onChange({ project_id: "" })} /> : null}
      {f.scheduled_from || f.scheduled_to ? (
        <Chip
          label={`Agendamento: ${rangeLabel({ from: f.scheduled_from, to: f.scheduled_to })}`}
          onClear={() => onChange({ scheduled_from: "", scheduled_to: "" })}
        />
      ) : null}
      {f.resolved_from || f.resolved_to ? (
        <Chip
          label={`Resolvida: ${rangeLabel({ from: f.resolved_from, to: f.resolved_to })}`}
          onClear={() => onChange({ resolved_from: "", resolved_to: "" })}
        />
      ) : null}
      {f.team_id ? <TeamChip id={f.team_id} onClear={() => onChange({ team_id: "" })} /> : null}
      {f.category_id ? <CategoryChip id={f.category_id} onClear={() => onChange({ category_id: "" })} /> : null}
      {f.type ? <Chip label={`Atendimento: ${TICKET_TYPE[f.type]}`} onClear={() => onChange({ type: "" })} /> : null}
      {f.source ? (
        <Chip label={`Origem: ${SOURCES.find((s) => s.value === f.source)?.label ?? f.source}`} onClear={() => onChange({ source: "" })} />
      ) : null}
      {orderLabel ? <Chip tone="neutral" label={`Ordem: ${orderLabel}`} onClear={onResetOrder} /> : null}
      {onClear ? (
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X aria-hidden className="size-3.5" />
          Limpar filtros
        </Button>
      ) : null}
    </div>
  );
}
