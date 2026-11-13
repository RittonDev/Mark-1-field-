"use client";

import { useMemo } from "react";
import { formatMinutes } from "@/lib/format";
import type { ServiceType, UUID } from "@/lib/types";
import { Combobox, searchText, type ComboItem } from "./Combobox";

/** Duração cadastrada e, quando há histórico, a real (mediana das OS concluídas deste tipo). */
export function serviceTypeTiming(t: ServiceType): string {
  const real =
    t.observed_count > 0 && t.observed_median_minutes != null
      ? ` · real ~${formatMinutes(t.observed_median_minutes)} (${t.observed_count.toLocaleString("pt-BR")} OS)`
      : "";
  return `${formatMinutes(t.estimated_minutes)}${real}`;
}

/**
 * Tipo de serviço (o "Tipo de OS" do Field Control) com busca: o catálogo tem centenas de tipos, quase
 * todos de um cliente ("Preventiva de loja - X"). Os do cliente da OS vêm primeiro.
 */
export function ServiceTypePicker({
  types,
  value,
  onChange,
  customerId,
  loading,
  id,
  labelledBy,
  ariaLabel,
  placeholder = "Buscar tipo de serviço",
}: {
  types: ServiceType[] | undefined;
  value: ServiceType | null;
  onChange: (type: ServiceType | null) => void;
  /** Cliente da OS: o catálogo dele aparece primeiro. */
  customerId?: UUID | null;
  loading?: boolean;
  id?: string;
  labelledBy?: string;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const items = useMemo<ComboItem<ServiceType>[]>(() => {
    const rank = (t: ServiceType) => (t.customer_id && t.customer_id === customerId ? 0 : t.customer_id ? 2 : 1);
    return [...(types ?? [])]
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "pt-BR"))
      .map((t) => ({
        key: t.id,
        item: t,
        label: t.name,
        haystack: searchText(`${t.name} ${t.customer?.name ?? ""}`),
      }));
  }, [types, customerId]);

  return (
    <Combobox
      items={items}
      value={value?.id ?? ""}
      valueLabel={value?.name}
      onChange={onChange}
      loading={loading}
      id={id}
      labelledBy={labelledBy}
      ariaLabel={ariaLabel ?? "Tipo de serviço"}
      placeholder={placeholder}
      emptyText="Nenhum tipo de serviço com esse nome"
      clearLabel="Tirar o tipo de serviço"
      renderItem={(t) => (
        <span className="flex flex-col">
          <span className="flex flex-wrap items-center gap-x-1.5 font-medium">
            {t.name}
            {t.customer ? (
              <span className="rounded bg-surface-3 px-1.5 text-[11px] font-medium text-ink-muted">{t.customer.name}</span>
            ) : null}
            {t.is_active ? null : <span className="text-[11px] font-medium text-ink-muted">(inativo)</span>}
          </span>
          <span className="text-xs text-ink-muted">{serviceTypeTiming(t)}</span>
        </span>
      )}
    />
  );
}
