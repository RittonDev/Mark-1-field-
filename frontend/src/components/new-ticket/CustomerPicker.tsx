"use client";

import { useMemo } from "react";
import { formatDocument } from "@/lib/format";
import type { Customer, UUID } from "@/lib/types";
import { Combobox, searchText, type ComboItem } from "./Combobox";

/** Cliente com busca por nome ou CNPJ (com ou sem pontuação). */
export function CustomerPicker({
  customers,
  value,
  onChange,
  includeInactive = false,
  loading,
  id,
  labelledBy,
  ariaLabel,
  invalid,
  describedBy,
  placeholder = "Buscar cliente por nome ou CNPJ",
}: {
  customers: Customer[] | undefined;
  value: UUID | "";
  onChange: (customer: Customer | null) => void;
  /** Filtro da lista de OS: clientes inativos também (as OS antigas continuam). */
  includeInactive?: boolean;
  loading?: boolean;
  id?: string;
  labelledBy?: string;
  ariaLabel?: string;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
}) {
  const items = useMemo<ComboItem<Customer>[]>(
    () =>
      (customers ?? [])
        // O cliente já escolhido continua na lista, mesmo inativo.
        .filter((c) => includeInactive || c.is_active || c.id === value)
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
        .map((c) => ({
          key: c.id,
          item: c,
          label: c.is_active ? c.name : `${c.name} (inativo)`,
          haystack: `${searchText(c.name)} ${c.document ?? ""}`,
        })),
    [customers, includeInactive, value],
  );

  return (
    <Combobox
      items={items}
      value={value}
      onChange={onChange}
      loading={loading}
      id={id}
      labelledBy={labelledBy}
      ariaLabel={ariaLabel ?? "Cliente"}
      invalid={invalid}
      describedBy={describedBy}
      placeholder={placeholder}
      emptyText="Nenhum cliente com esse nome ou CNPJ"
      clearLabel="Tirar o cliente"
      renderItem={(c) => (
        <span className="flex flex-col">
          <span className="font-medium">
            {c.name}
            {c.is_active ? null : <span className="ml-1.5 text-[11px] font-medium text-ink-muted">(inativo)</span>}
          </span>
          {c.document ? <span className="text-xs text-ink-muted tabular-nums">{formatDocument(c.document)}</span> : null}
        </span>
      )}
    />
  );
}
