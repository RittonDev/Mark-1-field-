"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListFilter, Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { LocationPicker } from "@/components/LocationPicker";
import { CustomerPicker } from "@/components/new-ticket/CustomerPicker";
import { Button, fieldClassName, Input, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { STATUS, STATUS_ORDER } from "@/lib/constants";
import { useDebounced } from "@/lib/hooks";
import { useCustomers } from "@/lib/queries";
import type { Customer, Location, TicketStatus, UUID } from "@/lib/types";
import { CREATED_PRESETS, DateRangeForm, rangeLabel } from "./DateRange";
import { type Filters, isOpenStatus, type ListState, parseTicketNumber, type View, writeListParams } from "./params";
import { FilterPopover, pillClassName } from "./Popover";

/** A loja do filtro (a URL guarda só o id): o nome no botão, no chip e no campo de loja. */
export function useFilterLocation(locationId: string) {
  return useQuery({
    queryKey: ["location", locationId],
    queryFn: ({ signal }) => api.get<Location>(`/locations/${locationId}`, undefined, { signal }),
    enabled: Boolean(locationId),
    staleTime: 60_000,
  });
}

/** Nome de um cadastro no botão ou no chip: "…" enquanto carrega e um aviso se não existe mais. */
export function nameOr(name: string | undefined, loading: boolean): string {
  return name ?? (loading ? "…" : "não encontrado");
}

function StatusFilter({
  value,
  openOnly,
  onChange,
  onAllViews,
}: {
  value: TicketStatus[];
  /** A aba mostra só OS em aberto: os status finais ficam de fora (a não ser que já estejam escolhidos). */
  openOnly: boolean;
  onChange: (status: TicketStatus[]) => void;
  onAllViews: () => void;
}) {
  const options = STATUS_ORDER.filter((s) => !openOnly || isOpenStatus(s) || value.includes(s));
  const summary = value.length === 0 ? null : value.length === 1 ? STATUS[value[0]].label : `${value.length} escolhidas`;
  const toggle = (s: TicketStatus) => onChange(STATUS_ORDER.filter((x) => (x === s ? !value.includes(s) : value.includes(x))));
  return (
    <FilterPopover label="Situação" value={summary} panelLabel="Filtrar pela situação" width="sm">
      {(close) => (
        <div className="flex flex-col gap-2">
          <fieldset>
            <legend className="mb-1 px-2 text-xs font-semibold text-ink/80">Situação da OS</legend>
            <ul role="list" className="flex max-h-72 flex-col overflow-y-auto">
              {options.map((s) => (
                <li key={s}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink transition-colors hover:bg-surface-2">
                    <input
                      type="checkbox"
                      checked={value.includes(s)}
                      onChange={() => toggle(s)}
                      className="size-4 shrink-0 rounded border-line accent-[var(--brand)]"
                    />
                    <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: STATUS[s].color }} />
                    {STATUS[s].label}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          {openOnly ? (
            <p className="border-t border-line px-2 pt-2 text-xs text-ink-muted">
              Esta aba mostra só OS em aberto.{" "}
              <button
                type="button"
                onClick={() => {
                  close();
                  onAllViews();
                }}
                className="rounded font-semibold text-brand-ink underline-offset-2 hover:underline"
              >
                Ver todas as situações
              </button>
            </p>
          ) : null}
          {value.length ? (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => onChange([])}>
                Limpar
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </FilterPopover>
  );
}

function CustomerFilter({
  value,
  customers,
  loading,
  onPick,
}: {
  value: UUID | "";
  customers: Customer[] | undefined;
  loading: boolean;
  onPick: (customerId: UUID | "") => void;
}) {
  const labelId = useId();
  const name = customers?.find((c) => c.id === value)?.name;
  return (
    <FilterPopover label="Cliente" value={value ? nameOr(name, loading) : null} panelLabel="Filtrar pelo cliente">
      {(close) => (
        <div className="flex flex-col gap-2">
          <span id={labelId} className="text-xs font-semibold text-ink/80">
            Cliente
          </span>
          <CustomerPicker
            customers={customers}
            loading={loading}
            includeInactive
            value={value}
            labelledBy={labelId}
            placeholder="Buscar por nome ou CNPJ"
            onChange={(c) => {
              onPick(c?.id ?? "");
              if (c) close();
            }}
          />
          {value ? (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onPick("");
                  close();
                }}
              >
                Limpar
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </FilterPopover>
  );
}

function NumberForm({ value, onApply }: { value: number | null; onApply: (n: number | null) => void }) {
  const ids = { input: useId(), hint: useId(), error: useId() };
  const [draft, setDraft] = useState(value !== null ? String(value) : "");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const text = draft.trim();
        if (!text) return onApply(null);
        const n = parseTicketNumber(text);
        if (n === null) return setError("Digite só o número da OS (ex.: 16976).");
        onApply(n);
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor={ids.input} className="text-xs font-semibold text-ink/80">
        Identificador da OS
      </label>
      <Input
        id={ids.input}
        data-autofocus
        inputMode="numeric"
        autoComplete="off"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        placeholder="Ex.: 16976"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? ids.error : ids.hint}
      />
      {error ? (
        <p id={ids.error} role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : (
        <p id={ids.hint} className="text-xs text-ink-muted">
          Procura em todas as OS, em qualquer aba (inclusive as fechadas).
        </p>
      )}
      <div className="flex justify-end gap-2">
        {value !== null ? (
          <Button size="sm" variant="ghost" onClick={() => onApply(null)}>
            Limpar
          </Button>
        ) : null}
        <Button type="submit" size="sm" variant="primary">
          Filtrar
        </Button>
      </div>
    </form>
  );
}

function LocationForm({
  initial,
  customerId,
  customerName,
  onPick,
  onClear,
  onClearCustomer,
}: {
  initial: Location | null;
  customerId: UUID | "";
  customerName: string | null;
  onPick: (location: Location) => void;
  onClear: (() => void) | null;
  onClearCustomer: () => void;
}) {
  const queryClient = useQueryClient();
  const labelId = useId();
  // A loja à vista no campo: "Trocar" volta para a busca sem mexer no filtro até a nova ser escolhida.
  const [draft, setDraft] = useState<Location | null>(initial);
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-xs font-semibold text-ink/80">
        {customerName ? `Loja de ${customerName}` : "Loja"}
      </span>
      <LocationPicker
        customerId={customerId || null}
        customerName={customerName}
        onClearCustomer={onClearCustomer}
        value={draft}
        labelledBy={labelId}
        onChange={(loc) => {
          if (!loc) return setDraft(null);
          // A loja escolhida já entra no cache: o nome aparece na hora no botão e no chip, sem o campo
          // trocar por um esqueleto (nem perder o foco) enquanto o cadastro carregaria de novo.
          queryClient.setQueryData(["location", loc.id], loc);
          onPick(loc);
        }}
      />
      {customerId ? null : <p className="text-xs text-ink-muted">Com um cliente escolhido, a busca fica só nas lojas dele.</p>}
      {onClear ? (
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClear}>
            Limpar
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function LocationFilter({
  value,
  location,
  loading,
  customerId,
  customerName,
  onChange,
}: {
  value: UUID | "";
  /** A loja do filtro, já carregada (ou carregando). */
  location: Location | undefined;
  loading: boolean;
  customerId: UUID | "";
  customerName: string | null;
  onChange: (patch: Partial<Filters>) => void;
}) {
  const summary = value ? nameOr(location?.name, loading) : null;
  return (
    <FilterPopover label="Localização" value={summary} panelLabel="Filtrar pela localização" width="lg">
      {(close) =>
        value && loading ? (
          <Skeleton className="h-9 w-full rounded-lg" />
        ) : (
          <LocationForm
            key={location?.id ?? "nenhuma"}
            initial={value ? (location ?? null) : null}
            customerId={customerId}
            customerName={customerName}
            onPick={(loc) => {
              onChange({ location_id: loc.id });
              close();
            }}
            onClear={
              value
                ? () => {
                    onChange({ location_id: "" });
                    close();
                  }
                : null
            }
            onClearCustomer={() => onChange({ customer_id: "" })}
          />
        )
      }
    </FilterPopover>
  );
}

/**
 * Busca de texto: o campo responde na hora e a URL (com a lista) acompanha quando a digitação para.
 * Número solto fica na aba: procura código de loja, nº do chamado do cliente e a OS com esse nº (a API
 * põe essa OS primeiro). "OS-16976" ou "#16976" procura a OS em todas as abas (para isso há também o
 * filtro Identificador).
 */
function SearchBox({ urlQ, view }: { urlQ: string; view: View }) {
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
  return (
    <div className="relative w-full sm:ml-auto sm:w-72">
      <Search aria-hidden className="pointer-events-none absolute top-2 left-3 size-4 text-ink-subtle" />
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Buscar loja, cliente, cidade, título..."
        title="Título, loja (nome, código ou cidade), cliente, técnico, nº do chamado do cliente, nº da OS ou descrição. “OS-16976” procura a OS em todas as abas."
        aria-label="Buscar chamados"
        className={fieldClassName("h-8 pl-9")}
      />
    </div>
  );
}

/**
 * Fileira de filtros da lista, como no Field Control: "Mais filtros" (o resto, num painel) e os
 * filtros mais usados à vista, cada um com o valor escolhido no próprio botão. A busca fica no fim.
 */
export function FilterBar({
  state,
  onChange,
  onAllViews,
  moreCount,
  moreOpen,
  moreId,
  onOpenMore,
}: {
  state: ListState;
  onChange: (patch: Partial<Filters>) => void;
  onAllViews: () => void;
  moreCount: number;
  /** O painel "Mais filtros" está aberto (e o id dele, para o leitor de tela). */
  moreOpen: boolean;
  moreId: string;
  onOpenMore: () => void;
}) {
  const f = state.filters;
  const customers = useCustomers();
  const customerName = customers.data?.find((c) => c.id === f.customer_id)?.name;
  const location = useFilterLocation(f.location_id);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filtros da lista">
      <button
        type="button"
        onClick={onOpenMore}
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        aria-controls={moreOpen ? moreId : undefined}
        className={pillClassName(moreCount > 0)}
      >
        <ListFilter aria-hidden className="size-3.5 shrink-0" />
        Mais filtros
        {moreCount > 0 ? (
          <span className="rounded-full bg-brand px-1.5 text-[11px] leading-[18px] font-semibold text-white tabular-nums dark:bg-brand-strong">
            {moreCount}
            <span className="sr-only"> em uso</span>
          </span>
        ) : null}
      </button>
      <span aria-hidden className="mx-0.5 hidden h-5 w-px bg-line sm:block" />
      <StatusFilter
        value={f.status}
        openOnly={state.view !== "todas"}
        onChange={(status) => onChange({ status })}
        onAllViews={onAllViews}
      />
      <CustomerFilter
        value={f.customer_id}
        customers={customers.data}
        loading={customers.isLoading}
        onPick={(customerId) => {
          // Loja de outro cliente não combina com o cliente novo: sai do filtro.
          const store = location.data;
          const dropStore = Boolean(customerId && store && store.customer_id !== customerId);
          onChange(dropStore ? { customer_id: customerId, location_id: "" } : { customer_id: customerId });
        }}
      />
      <FilterPopover
        label="Identificador"
        value={f.number !== null ? String(f.number) : null}
        panelLabel="Filtrar pelo identificador"
        width="sm"
      >
        {(close) => (
          <NumberForm
            value={f.number}
            onApply={(number) => {
              onChange({ number });
              close();
            }}
          />
        )}
      </FilterPopover>
      <LocationFilter
        value={f.location_id}
        location={location.data}
        loading={location.isLoading}
        customerId={f.customer_id}
        customerName={customerName ?? null}
        onChange={onChange}
      />
      <FilterPopover
        label="Criação"
        value={rangeLabel({ from: f.created_from, to: f.created_to }) || null}
        panelLabel="Filtrar pela data de criação"
      >
        {(close) => (
          <DateRangeForm
            value={{ from: f.created_from, to: f.created_to }}
            presets={CREATED_PRESETS}
            legend="Data de criação da OS"
            onApply={(range) => {
              onChange({ created_from: range.from, created_to: range.to });
              close();
            }}
          />
        )}
      </FilterPopover>
      <SearchBox urlQ={state.q} view={state.view} />
    </div>
  );
}
