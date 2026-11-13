"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { History, Loader2, MapPin, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { readStored, writeStored } from "@/components/new-ticket/storage";
import { Button, Input } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDocument } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import type { Location, Page, UUID } from "@/lib/types";

const PAGE_SIZE = 8;
const RECENT_MAX = 5;

/** O que fica guardado das últimas lojas escolhidas: só o que aparece na lista (sem contatos). */
interface RecentLocation {
  id: UUID;
  name: string;
  code: string | null;
  customer_id: UUID;
  customer: string;
  city: string | null;
  state: string | null;
}

type Row = { key: string; recent: RecentLocation; location?: undefined } | { key: string; location: Location; recent?: undefined };

const recentKey = (userId: string) => `maxx.lojas.recentes.${userId}`;

function town(city: string | null, state: string | null) {
  return city ? `${city}${state ? `/${state}` : ""}` : null;
}

function describe(l: Location) {
  return [l.customer.name, town(l.city, l.state), l.document ? formatDocument(l.document) : null].filter(Boolean).join(" · ");
}

function RowText({ row }: { row: Row }) {
  const item = row.recent ?? row.location;
  return (
    <>
      <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-ink">
        {row.recent ? <History aria-hidden className="size-3.5 shrink-0 text-ink-subtle" /> : null}
        <span className="truncate">
          {item.code ? <span className="font-mono text-xs font-normal text-ink-muted">{item.code} · </span> : null}
          {item.name}
        </span>
      </p>
      <p className="truncate text-xs text-ink-muted">
        {row.recent ? [row.recent.customer, town(row.recent.city, row.recent.state)].filter(Boolean).join(" · ") : describe(row.location)}
      </p>
    </>
  );
}

/**
 * Busca de loja (filial, com CNPJ próprio) por nome, código, CNPJ, endereço ou cliente: com milhares de
 * lojas, um select não serve. Escolher a loja também define o cliente. Sem texto, mostra as últimas
 * escolhidas e, com cliente escolhido, as lojas dele. Setas e Enter escolhem; o Enter nunca envia o
 * formulário em volta e o Esc fecha só a lista.
 */
export function LocationPicker({
  customerId,
  value,
  onChange,
  customerName,
  onClearCustomer,
  initialQuery = "",
  autoFocus,
  inputId,
  labelledBy,
  invalid,
  describedBy,
}: {
  customerId: UUID | null;
  value: Location | null;
  onChange: (location: Location | null) => void;
  /** Nome do cliente que limita a busca (para dizer isso quando nada é achado). */
  customerName?: string | null;
  /** "Buscar em todos os clientes": tira o cliente que limita a busca. */
  onClearCustomer?: () => void;
  /** Texto inicial da busca (ex.: a loja citada na mensagem do cliente). */
  initialQuery?: string;
  autoFocus?: boolean;
  inputId?: string;
  /** id do rótulo visível (o campo fica fora de um <label>). */
  labelledBy?: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const listId = useId();
  const [q, setQ] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loadingId, setLoadingId] = useState<UUID | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentLocation[]>(() =>
    user ? (readStored<RecentLocation[]>("local", recentKey(user.id)) ?? []) : [],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  // Depois de escolher, o foco vai para "Trocar"; depois de "Trocar", volta para a busca.
  const focusNext = useRef<{ to: "change"; id: UUID } | { to: "input" } | null>(null);

  const term = q.trim();
  const debounced = useDebounced(term, 250);
  const browsing = term === "";
  const results = useQuery({
    queryKey: ["locations", "search", debounced, customerId ?? "", true, 1, PAGE_SIZE],
    queryFn: () =>
      api.get<Page<Location>>("/locations", {
        q: debounced || undefined,
        customer_id: customerId ?? undefined,
        active: true,
        page: 1,
        page_size: PAGE_SIZE,
      }),
    // Só com a lista aberta. Sem texto, só com cliente escolhido (as lojas dele); senão, as recentes.
    enabled: open && !value && (debounced !== "" || Boolean(customerId)),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const recentRows: Row[] = browsing
    ? recents.filter((r) => !customerId || r.customer_id === customerId).map((r) => ({ key: `recente-${r.id}`, recent: r }))
    : [];
  const showResults = !browsing || Boolean(customerId);
  const resultItems = showResults && results.data && (!browsing || debounced === "") ? results.data.items : [];
  const resultRows: Row[] = resultItems
    .filter((l) => !recentRows.some((r) => r.recent?.id === l.id))
    .map((l) => ({ key: l.id, location: l }));
  const rows = [...recentRows, ...resultRows];
  // Resultado de uma busca anterior ainda na tela enquanto a nova não chega.
  const stale = !browsing && (term !== debounced || results.isPlaceholderData);
  const searching = showResults && (stale || results.isFetching);
  const more = resultItems.length && results.data ? results.data.total - resultItems.length : 0;

  // Lista nova: o destaque volta para o primeiro item.
  const rowsKey = rows.map((r) => r.key).join("|");
  const [seenRows, setSeenRows] = useState(rowsKey);
  if (seenRows !== rowsKey) {
    setSeenRows(rowsKey);
    setActive(0);
  }
  const activeIndex = Math.max(0, Math.min(active, rows.length - 1));

  useEffect(() => {
    const next = focusNext.current;
    if (next?.to === "change" && value?.id === next.id) {
      focusNext.current = null;
      changeRef.current?.focus();
    } else if (next?.to === "input" && !value) {
      focusNext.current = null;
      inputRef.current?.focus();
    }
  }, [value]);

  // A opção destacada pelas setas fica sempre à vista na lista.
  useEffect(() => {
    if (open) document.getElementById(`${listId}-o${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, listId]);

  const saveRecents = (next: RecentLocation[]) => {
    setRecents(next);
    if (user) writeStored("local", recentKey(user.id), next);
  };

  const choose = (l: Location) => {
    saveRecents(
      [
        { id: l.id, name: l.name, code: l.code, customer_id: l.customer_id, customer: l.customer.name, city: l.city, state: l.state },
        ...recents.filter((r) => r.id !== l.id),
      ].slice(0, RECENT_MAX),
    );
    focusNext.current = { to: "change", id: l.id };
    setQ("");
    setOpen(false);
    setPickError(null);
    onChange(l);
  };

  const pick = async (row: Row) => {
    if (row.location) return choose(row.location);
    const recent = row.recent;
    setLoadingId(recent.id);
    setPickError(null);
    try {
      // A recente guarda só o nome: a loja entra na OS com o cadastro de agora (endereço, contato).
      const loc = await queryClient.fetchQuery({
        queryKey: ["location", recent.id],
        queryFn: () => api.get<Location>(`/locations/${recent.id}`),
        staleTime: 30_000,
      });
      if (loc.is_active) return choose(loc);
      saveRecents(recents.filter((r) => r.id !== recent.id));
      setPickError(`${recent.name} foi desativada no cadastro.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) saveRecents(recents.filter((r) => r.id !== recent.id));
      setPickError(errorMessage(err));
    } finally {
      setLoadingId(null);
    }
  };

  if (value) {
    return (
      <div
        // Dentro de um <label>, clicar no nome da loja acionaria o botão "Trocar" (o 1º controle do rótulo).
        onClick={(e) => {
          if (!(e.target as Element).closest("button, a")) e.preventDefault();
        }}
        className="flex items-start justify-between gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm"
      >
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-semibold text-ink">
            <MapPin aria-hidden className="size-3.5 shrink-0 text-ink-muted" />
            <span className="truncate" title={value.name}>
              {value.code ? <span className="font-mono text-xs font-normal text-ink-muted">{value.code} · </span> : null}
              {value.name}
            </span>
          </p>
          <p className="mt-0.5 truncate text-xs text-ink-muted" title={describe(value)}>
            {describe(value)}
          </p>
        </div>
        <Button
          ref={changeRef}
          size="sm"
          variant="ghost"
          onClick={() => {
            focusNext.current = { to: "input" };
            onChange(null);
          }}
          aria-label={`Trocar a loja ${value.name}`}
        >
          <X aria-hidden className="size-3.5" />
          Trocar
        </Button>
      </div>
    );
  }

  const status = !open
    ? ""
    : loadingId
      ? "Carregando a loja..."
      : searching && rows.length === 0
        ? "Buscando..."
        : rows.length
          ? `${rows.length} ${rows.length === 1 ? "loja" : "lojas"} na lista`
          : browsing
            ? ""
            : "Nenhuma loja encontrada";

  const option = (row: Row, i: number) => (
    <li
      key={row.key}
      id={`${listId}-o${i}`}
      role="option"
      aria-selected={i === activeIndex}
      // mousedown antes do blur do campo: a lista continua aberta até o clique.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void pick(row)}
      onMouseMove={() => {
        if (i !== activeIndex) setActive(i);
      }}
      className={clsx(
        "flex cursor-pointer items-center gap-2 px-3 py-2",
        i === activeIndex && "bg-surface-2",
        row.location && stale && "opacity-60",
      )}
    >
      <span className="min-w-0 flex-1">
        <RowText row={row} />
      </span>
      {row.recent && loadingId === row.recent.id ? <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-ink-subtle" /> : null}
    </li>
  );
  const heading = (text: string) => (
    <li role="presentation" className="px-3 pt-2 pb-1 text-[11px] font-bold tracking-[0.06em] text-ink-muted uppercase">
      {text}
    </li>
  );

  return (
    <div className="relative">
      <Search aria-hidden className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-muted" />
      <Input
        ref={inputRef}
        id={inputId}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) return setOpen(true);
            if (!rows.length) return;
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((activeIndex + step + rows.length) % rows.length);
          } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
            // Enter escolhe a loja destacada e nunca envia o formulário em volta (a OS sairia sem loja).
            e.preventDefault();
            if (!open || stale || loadingId) return;
            const row = rows[activeIndex];
            if (row) void pick(row);
          } else if (e.key === "Escape") {
            // Esc fecha só a lista: o painel da OS em volta ignora a tecla já tratada aqui.
            if (open) {
              e.preventDefault();
              setOpen(false);
            } else if (q) {
              e.preventDefault();
              setQ("");
            }
          }
        }}
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder="Buscar loja por nome, código, CNPJ ou cidade"
        className="pr-9 pl-9"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && rows.length ? `${listId}-o${activeIndex}` : undefined}
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : "Buscar loja"}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
      {open && searching ? (
        <Loader2 aria-hidden className="pointer-events-none absolute top-2.5 right-3 size-4 animate-spin text-ink-subtle" />
      ) : null}
      <span className="sr-only" aria-live="polite">
        {status}
      </span>
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Lojas"
          aria-busy={searching || undefined}
          // Clicar em qualquer ponto da lista (título, aviso) não tira o foco da busca.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute z-30 mt-1 max-h-80 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-pop"
        >
          {recentRows.length ? heading("Recentes") : null}
          {recentRows.map((row, i) => option(row, i))}
          {browsing && resultRows.length ? heading(`Lojas de ${customerName || "do cliente"}`) : null}
          {resultRows.map((row, i) => option(row, recentRows.length + i))}
          {rows.length === 0 ? (
            <li role="presentation" className="px-3 py-2 text-sm text-ink-muted">
              {browsing && !customerId ? (
                "Digite o nome, o código, o CNPJ ou a cidade da loja."
              ) : searching ? (
                "Buscando..."
              ) : customerId && !browsing ? (
                <span className="flex flex-col items-start gap-1.5">
                  <span>
                    Nenhuma loja de {customerName || "deste cliente"} com “{term}”.
                  </span>
                  {onClearCustomer ? (
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={onClearCustomer}
                      className="text-xs font-semibold text-brand-ink hover:underline"
                    >
                      Buscar em todos os clientes
                    </button>
                  ) : null}
                </span>
              ) : (
                "Nenhuma loja encontrada."
              )}
            </li>
          ) : null}
          {pickError ? (
            <li role="presentation" className="px-3 py-2 text-xs font-medium text-red-600 dark:text-red-400">
              {pickError}
            </li>
          ) : null}
          {more > 0 ? (
            <li role="presentation" className="border-t border-line px-3 py-2 text-xs text-ink-muted">
              Mais {more.toLocaleString("pt-BR")} {more === 1 ? "loja" : "lojas"}: refine a busca
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
