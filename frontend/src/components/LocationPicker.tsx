"use client";

import { MapPin, Search, X } from "lucide-react";
import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { formatDocument } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useLocationSearch } from "@/lib/queries";
import type { Location, UUID } from "@/lib/types";

function describe(l: Location) {
  return [l.customer.name, l.city ? `${l.city}${l.state ? `/${l.state}` : ""}` : null, l.document ? formatDocument(l.document) : null]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Busca de local (filial) por nome, código, CNPJ, endereço ou cliente — com milhares de locais,
 * um select não serve. Escolher o local também define o cliente.
 */
export function LocationPicker({
  customerId,
  value,
  onChange,
}: {
  customerId: UUID | null;
  value: Location | null;
  onChange: (location: Location | null) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const debounced = useDebounced(q.trim(), 250);
  const results = useLocationSearch({ q: debounced, customerId, active: true, pageSize: 8 });
  const items = results.data?.items ?? [];
  const more = (results.data?.total ?? 0) - items.length;

  if (value) {
    return (
      <div className="flex items-start justify-between gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-semibold text-ink">
            <MapPin className="size-3.5 shrink-0 text-ink-muted" />
            <span className="truncate">
              {value.code ? <span className="font-mono text-xs font-normal text-ink-muted">{value.code} · </span> : null}
              {value.name}
            </span>
          </p>
          <p className="mt-0.5 truncate text-xs text-ink-muted">{describe(value)}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => onChange(null)} aria-label="Trocar local">
          <X className="size-3.5" />
          Trocar
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-muted" />
      <Input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        placeholder="Buscar por nome, código, CNPJ ou cidade"
        className="pl-9"
        role="combobox"
        aria-expanded={open}
        aria-label="Buscar local de atendimento"
      />
      {open ? (
        <ul className="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-lg">
          {results.isLoading ? (
            <li className="px-3 py-2 text-sm text-ink-muted">Buscando...</li>
          ) : items.length === 0 ? (
            <li className="px-3 py-2 text-sm text-ink-muted">Nenhum local encontrado</li>
          ) : (
            items.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  // mousedown antes do blur do input: mantém a lista aberta até o clique.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(l);
                    setQ("");
                    setOpen(false);
                  }}
                  className="w-full px-3 py-2 text-left hover:bg-surface-2"
                >
                  <p className="text-sm font-semibold text-ink">
                    {l.code ? <span className="font-mono text-xs font-normal text-ink-muted">{l.code} · </span> : null}
                    {l.name}
                  </p>
                  <p className="text-xs text-ink-muted">{describe(l)}</p>
                </button>
              </li>
            ))
          )}
          {more > 0 ? (
            <li className="border-t border-line px-3 py-2 text-xs text-ink-muted">
              +{more} local(is) — refine a busca
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
