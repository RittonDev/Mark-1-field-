"use client";

import clsx from "clsx";
import { X } from "lucide-react";
import { Button } from "@/components/ui";
import { PRIORITY, STATUS, TICKET_TYPE } from "@/lib/constants";
import { useProjects } from "@/lib/projects";
import { useAssignable, useCategories, useCustomers, useServiceTypes, useTeams } from "@/lib/queries";
import type { UUID } from "@/lib/types";
import { useFilterLocation } from "./FiltersCard";
import { type Filters, SOURCES } from "./params";

function Chip({ label, onClear, tone = "brand" }: { label: string; onClear: () => void; tone?: "brand" | "amber" }) {
  return (
    <span
      className={clsx(
        "inline-flex max-w-full animate-enter items-center gap-1 rounded-full py-1 pr-1 pl-2.5 text-xs font-medium",
        tone === "brand" ? "bg-brand-soft text-brand-ink" : "bg-amber-500/10 text-amber-800 dark:text-amber-300",
      )}
    >
      <span className="truncate" title={label}>
        {label}
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remover filtro: ${label}`}
        title="Remover filtro"
        className="shrink-0 rounded-full p-0.5 transition-colors hover:bg-ink/10"
      >
        <X aria-hidden className="size-3" />
      </button>
    </span>
  );
}

/** Nome de um cadastro para o chip: "…" enquanto carrega e um aviso se não existe mais. */
function nameOr(name: string | undefined, loading: boolean): string {
  return name ?? (loading ? "…" : "não encontrado");
}

// Cada chip de cadastro busca o nome só quando aparece (o cadastro já costuma estar em cache).

function TechnicianChip({ id, onClear }: { id: UUID; onClear: () => void }) {
  const people = useAssignable(null);
  return <Chip label={`Técnico: ${nameOr(people.data?.find((u) => u.id === id)?.name, people.isLoading)}`} onClear={onClear} />;
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
  const name = l ? [l.code, l.name].filter(Boolean).join(" · ") : undefined;
  return <Chip label={`Loja: ${nameOr(name, location.isLoading)}`} onClear={onClear} />;
}

function ServiceTypeChip({ id, onClear }: { id: UUID; onClear: () => void }) {
  const types = useServiceTypes();
  return <Chip label={`Tipo de serviço: ${nameOr(types.data?.find((t) => t.id === id)?.name, types.isLoading)}`} onClear={onClear} />;
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
 * Filtros em uso, sempre à vista (mesmo com o cartão "Filtros" fechado), cada um com o nome e o × que
 * o tira. "Limpar filtros" tira todos e a busca.
 */
export function ActiveFilters({
  filters: f,
  ownerName,
  userId,
  onChange,
  onClear,
}: {
  filters: Filters;
  /** Nome do analista da fila escolhida. */
  ownerName: string | undefined;
  userId: UUID | undefined;
  onChange: (patch: Partial<Filters>) => void;
  onClear: () => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filtros em uso">
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
        <Chip key={s} label={`Status: ${STATUS[s].label}`} onClear={() => onChange({ status: f.status.filter((x) => x !== s) })} />
      ))}
      {f.priority.map((p) => (
        <Chip
          key={p}
          label={`${PRIORITY[p].code} · ${PRIORITY[p].label}`}
          onClear={() => onChange({ priority: f.priority.filter((x) => x !== p) })}
        />
      ))}
      {f.type ? <Chip label={`Tipo: ${TICKET_TYPE[f.type]}`} onClear={() => onChange({ type: "" })} /> : null}
      {f.source ? (
        <Chip label={`Origem: ${SOURCES.find((s) => s.value === f.source)?.label ?? f.source}`} onClear={() => onChange({ source: "" })} />
      ) : null}
      {f.customer_id ? <CustomerChip id={f.customer_id} onClear={() => onChange({ customer_id: "" })} /> : null}
      {f.location_id ? <LocationChip id={f.location_id} onClear={() => onChange({ location_id: "" })} /> : null}
      {f.service_type_id ? <ServiceTypeChip id={f.service_type_id} onClear={() => onChange({ service_type_id: "" })} /> : null}
      {f.assignee_id ? <TechnicianChip id={f.assignee_id} onClear={() => onChange({ assignee_id: "" })} /> : null}
      {f.team_id ? <TeamChip id={f.team_id} onClear={() => onChange({ team_id: "" })} /> : null}
      {f.category_id ? <CategoryChip id={f.category_id} onClear={() => onChange({ category_id: "" })} /> : null}
      {f.project_id ? <ProjectChip id={f.project_id} onClear={() => onChange({ project_id: "" })} /> : null}
      <Button variant="ghost" size="sm" onClick={onClear}>
        <X aria-hidden className="size-3.5" />
        Limpar filtros
      </Button>
    </div>
  );
}
