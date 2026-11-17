"use client";

import clsx from "clsx";
import { Loader2, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Kbd } from "@/components/ui";
import type { User } from "@/lib/types";
import { readRecent, type RecentTicket } from "./search";
import { SearchResults, useSearchController } from "./SearchResults";

/** Exemplos do que a busca entende (um clique preenche o campo). */
const EXAMPLES = ["atrasadas", "agendadas amanhã", "sem técnico", "técnico joão novembro", "pendente pgto semana passada"];

/** Campo onde a tecla digitada é texto: o "/" não pode roubar o foco dele. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Busca grande do Início: OS, clientes, locais, técnicos, telas e ações, com a frase entendida pela API
 * ("atrasadas em santos", "16976", "técnico joão novembro"). "/" leva o foco para ela; os resultados
 * abrem logo abaixo, com setas, Enter (Ctrl+Enter abre a página; Shift+Enter, outra aba) e Esc.
 */
export function HomeSearch({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<RecentTicket[]>(() => readRecent(user.id));
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const close = () => setOpen(false);
  const ctl = useSearchController({ user, recent, mode: "home", onLeave: close });
  const showPanel = open && (ctl.typed !== "" || recent.length > 0);

  // "/" em qualquer lugar da tela (fora de um campo, sem diálogo ou menu aberto) leva à busca.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || isTypingTarget(e.target)) return;
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // 1º Esc fecha a lista; o 2º limpa o texto; o 3º sai do campo.
      e.preventDefault();
      if (showPanel) setOpen(false);
      else if (ctl.query) ctl.setQuery("");
      else inputRef.current?.blur();
      return;
    }
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    ctl.onKeyDown(e);
  };

  const pick = (text: string) => {
    ctl.setQuery(text);
    setOpen(true);
    inputRef.current?.focus();
  };

  return (
    <div
      ref={wrapRef}
      className="relative"
      onBlur={(e) => {
        // O foco saiu da busca (Tab, clique fora): a lista fecha. Dentro dela (ex.: "Tentar de novo"), não.
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div
        className={clsx(
          "flex items-center gap-3 rounded-xl border border-line bg-surface px-4 shadow-elev-1 transition-[border-color,box-shadow] duration-150",
          "hover:border-line-strong focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/15",
          "dark:border-line-strong dark:bg-surface-2",
        )}
      >
        <Search aria-hidden className="size-5 shrink-0 text-ink-subtle" />
        <input
          ref={inputRef}
          value={ctl.query}
          onChange={(e) => {
            ctl.setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setRecent(readRecent(user.id));
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          placeholder="Busque OS, cliente, loja, técnico ou tela… ex.: “atrasadas em santos”, “16976”, “técnico joão novembro”"
          className="h-12 min-w-0 flex-1 truncate bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-subtle"
          role="combobox"
          aria-label="Buscar OS, cliente, loja, técnico ou tela"
          aria-describedby={hintId}
          aria-expanded={showPanel}
          aria-controls={showPanel ? ctl.listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={showPanel ? ctl.activeId : undefined}
          aria-keyshortcuts="/"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        {ctl.fetching ? <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-ink-subtle" /> : null}
        {ctl.query ? (
          <button
            type="button"
            onClick={() => {
              ctl.setQuery("");
              inputRef.current?.focus();
            }}
            aria-label="Limpar a busca"
            className="-mr-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <X aria-hidden className="size-4" />
          </button>
        ) : (
          <span aria-hidden className="hidden sm:inline-flex">
            <Kbd>/</Kbd>
          </span>
        )}
      </div>

      {showPanel ? (
        <div className="absolute inset-x-0 top-full z-30 mt-2 flex animate-pop flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
          <div ref={ctl.listRef} className="max-h-[min(62vh,540px)] overflow-y-auto p-2">
            <SearchResults ctl={ctl} onLeave={close} />
          </div>
          <div className="hidden items-center gap-4 border-t border-line bg-surface-2/60 px-4 py-2 text-[11px] text-ink-subtle sm:flex">
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navegar
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Enter</Kbd> abrir
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Esc</Kbd> fechar
            </span>
            <span className="ml-auto inline-flex items-center gap-1">
              <Kbd>Ctrl</Kbd>
              <Kbd>Enter</Kbd> abre a página
            </span>
          </div>
        </div>
      ) : null}

      <div id={hintId} className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-ink-muted">
        <span className="mr-1">Experimente:</span>
        {EXAMPLES.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => pick(text)}
            className="rounded-md px-1.5 py-0.5 font-medium text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
