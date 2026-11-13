"use client";

import clsx from "clsx";
import { Check, ChevronDown, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Input } from "@/components/ui";

/** Texto para a busca: sem acento e em minúsculas. */
export function searchText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Palavras digitadas; as que têm número viram só letras e dígitos (CNPJ com ou sem pontuação). */
function searchWords(query: string): string[] {
  return searchText(query)
    .split(/\s+/)
    .map((w) => (/\d/.test(w) ? w.replace(/[^\da-z]/g, "") : w))
    .filter(Boolean);
}

export interface ComboItem<T> {
  key: string;
  item: T;
  /** Texto do campo com o item escolhido. */
  label: string;
  /** Onde a busca procura, já com searchText (nome, cliente, CNPJ só com dígitos...). */
  haystack: string;
}

/**
 * Campo com busca para listas longas (204 tipos de serviço, 151 clientes): digita, filtra por palavras
 * em qualquer ordem e sem acento, e escolhe com o mouse ou com as setas e o Enter. Enter nunca envia o
 * formulário em volta e o Esc fecha só a lista (não o diálogo ou o painel da OS).
 */
export function Combobox<T>({
  items,
  value,
  onChange,
  renderItem,
  placeholder,
  emptyText,
  valueLabel,
  clearLabel,
  id,
  labelledBy,
  ariaLabel,
  invalid,
  describedBy,
  loading = false,
  limit = 60,
}: {
  items: ComboItem<T>[];
  /** key do item escolhido ("" = nenhum). */
  value: string;
  onChange: (item: T | null) => void;
  renderItem: (item: T) => React.ReactNode;
  placeholder: string;
  emptyText: string;
  /** Texto do valor atual quando ele não está na lista (ex.: cliente inativo). */
  valueLabel?: string;
  /** Rótulo do botão que limpa o campo; sem ele, não há como limpar. */
  clearLabel?: string;
  id?: string;
  labelledBy?: string;
  ariaLabel?: string;
  invalid?: boolean;
  describedBy?: string;
  loading?: boolean;
  limit?: number;
}) {
  const listId = useId();
  // null: lista fechada, o campo mostra o escolhido. Texto: lista aberta, filtrando.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const open = query !== null;
  const selected = items.find((i) => i.key === value) ?? null;
  const shownLabel = selected?.label ?? (value ? (valueLabel ?? "") : "");

  const matches = useMemo(() => {
    if (query === null) return [];
    const words = searchWords(query);
    return words.length ? items.filter((i) => words.every((w) => i.haystack.includes(w))) : items;
  }, [items, query]);
  const visible = matches.slice(0, limit);
  const activeIndex = Math.max(0, Math.min(active, visible.length - 1));
  const optionId = (i: number) => `${listId}-o${i}`;

  // A opção destacada pelas setas fica sempre à vista na lista.
  useEffect(() => {
    if (open) document.getElementById(`${listId}-o${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, listId]);

  const openList = () => {
    if (open) return;
    setQuery("");
    const index = items.findIndex((i) => i.key === value);
    setActive(index >= 0 && index < limit ? index : 0);
  };
  const pick = (entry: ComboItem<T>) => {
    onChange(entry.item);
    setQuery(null);
  };

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && visible.length ? optionId(activeIndex) : undefined}
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        value={open ? query : shownLabel}
        placeholder={open && shownLabel ? shownLabel : placeholder}
        onFocus={openList}
        onClick={openList}
        onBlur={() => setQuery(null)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) return openList();
            if (!visible.length) return;
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((activeIndex + step + visible.length) % visible.length);
          } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
            // Enter escolhe; nunca envia o formulário.
            e.preventDefault();
            if (open && visible[activeIndex]) pick(visible[activeIndex]);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            setQuery(null);
          }
        }}
        className="pr-14"
      />
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-0.5">
        {value && clearLabel ? (
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange(null);
              setQuery(null);
            }}
            className="pointer-events-auto rounded p-1 text-ink-subtle hover:bg-surface-2 hover:text-ink"
            aria-label={clearLabel}
            title={clearLabel}
          >
            <X className="size-3.5" />
          </button>
        ) : null}
        <ChevronDown aria-hidden className="size-4 text-ink-subtle" />
      </span>
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-labelledby={labelledBy}
          aria-label={labelledBy ? undefined : ariaLabel}
          className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-pop"
        >
          {visible.length === 0 ? (
            <li role="presentation" className="px-3 py-2 text-sm text-ink-muted">
              {loading ? "Carregando..." : emptyText}
            </li>
          ) : (
            visible.map((entry, i) => (
              <li
                key={entry.key}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                // mousedown antes do blur do campo: a lista continua aberta até o clique.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(entry)}
                onMouseMove={() => {
                  if (i !== activeIndex) setActive(i);
                }}
                className={clsx(
                  "flex cursor-pointer items-start gap-2 px-3 py-2 text-sm text-ink",
                  i === activeIndex && "bg-surface-2",
                )}
              >
                <span className="min-w-0 flex-1">{renderItem(entry.item)}</span>
                {entry.key === value ? <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-brand" /> : null}
              </li>
            ))
          )}
          {matches.length > visible.length ? (
            <li role="presentation" className="border-t border-line px-3 py-2 text-xs text-ink-muted">
              Mais {(matches.length - visible.length).toLocaleString("pt-BR")}: refine a busca
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
