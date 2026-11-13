"use client";

import clsx from "clsx";
import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { fieldClassName } from "@/components/ui";

export interface MultiOption {
  value: string;
  label: string;
  color?: string;
}

// Lista longa (técnicos, áreas de atuação): ganha um campo para filtrar pelo nome.
const SEARCH_FROM = 9;
const MENU_WIDTH = 256;

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/**
 * Filtro de várias opções (status, prioridade, técnicos). Mesmo visual dos outros campos; teclado no
 * padrão de menu: ao abrir o foco vai para a lista (ou para a busca, em listas longas), setas, Home e
 * End andam entre as opções, espaço ou Enter marcam, Esc fecha e devolve o foco ao botão, e sair com
 * o Tab fecha a lista.
 */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  ariaLabel,
}: {
  label: string;
  options: MultiOption[];
  value: string[];
  onChange: (value: string[]) => void;
  /** Para quando o rótulo visível fica fora do botão: o leitor de tela ouve "<ariaLabel>: <resumo>". */
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  // Perto da borda direita da tela a lista abre alinhada à direita do botão (não sai da tela).
  const [alignRight, setAlignRight] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const searchable = options.length >= SEARCH_FROM;

  const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);

  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    setAlignRight(!!rect && rect.left + Math.max(rect.width, MENU_WIDTH) > window.innerWidth - 16);
    setFilter("");
    setOpen(true);
  };
  const hide = (focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // Ao abrir: o foco vai para a busca (lista longa) ou para a primeira opção.
    if (searchRef.current) searchRef.current.focus();
    else ref.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  const summary =
    value.length === 0
      ? label
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? label)
        : `${label} (${value.length})`;
  const text = normalize(filter);
  const visible = text ? options.filter((o) => normalize(o.label).includes(text)) : options;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.key === "Escape") {
      // Esc fecha só a lista (e não o diálogo ou o painel da OS em volta), e o foco volta ao botão.
      e.preventDefault();
      hide(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const list = items();
    if (!list.length) return;
    // Na busca, Home e End movem o cursor do texto; só as setas descem para a lista.
    const inSearch = e.target === searchRef.current;
    if (inSearch && (e.key === "Home" || e.key === "End")) return;
    e.preventDefault();
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Home") list[0].focus();
    else if (e.key === "End") list[list.length - 1].focus();
    else if (e.key === "ArrowDown") list[inSearch || index < 0 ? 0 : (index + 1) % list.length].focus();
    else if (index <= 0 && searchRef.current) searchRef.current.focus();
    else list[index <= 0 ? list.length - 1 : index - 1].focus();
  };

  return (
    <div
      ref={ref}
      className="relative"
      onKeyDown={onKeyDown}
      // Foco foi para outro campo (Tab, clique): a lista fecha. Clique fora em área sem foco fica com o
      // mousedown do documento; sem destino (Safari não dá foco ao botão clicado) a lista continua.
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (open && next && !e.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        onClick={() => (open ? hide(false) : show())}
        aria-label={ariaLabel ? `${ariaLabel}: ${summary}` : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-active={value.length > 0 || undefined}
        className={fieldClassName(
          "inline-flex h-9 items-center justify-between gap-2 text-left data-[active=true]:border-brand/60 aria-expanded:border-brand",
        )}
      >
        {/* Sem nada marcado, o resumo é só o nome do filtro (cinza); com filtro ativo, em tinta forte. */}
        <span className={clsx("truncate", value.length === 0 && "text-ink-muted")}>{summary}</span>
        <ChevronDown
          aria-hidden
          className={clsx("size-3.5 shrink-0 text-ink-subtle transition-transform duration-150", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div
          className={clsx(
            "absolute z-40 mt-1 w-64 max-w-[calc(100vw-2rem)] min-w-full animate-pop overflow-hidden rounded-xl border border-line bg-surface shadow-pop",
            alignRight ? "right-0" : "left-0",
          )}
        >
          {searchable ? (
            <div className="relative border-b border-line p-1.5">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-ink-subtle" />
              <input
                ref={searchRef}
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filtrar..."
                aria-label={`Filtrar ${ariaLabel ?? label}`}
                aria-controls={menuId}
                autoComplete="off"
                spellCheck={false}
                className="h-8 w-full rounded-lg bg-surface-2 pr-2 pl-8 text-sm text-ink outline-none placeholder:text-ink-subtle focus-visible:ring-2 focus-visible:ring-focus"
              />
            </div>
          ) : null}
          {/* role="menu": a lista conta como a camada de cima (o Esc do painel e do diálogo esperam por ela). */}
          <div id={menuId} role="menu" aria-label={ariaLabel ?? label} className="max-h-72 overflow-y-auto p-1">
            {visible.map((o) => {
              const checked = value.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  onClick={() => toggle(o.value)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <span
                    aria-hidden
                    className={clsx(
                      "flex size-4 shrink-0 items-center justify-center rounded border",
                      checked ? "border-brand bg-brand text-white dark:border-brand-strong dark:bg-brand-strong" : "border-line-strong",
                    )}
                  >
                    {checked ? <Check className="size-3" /> : null}
                  </span>
                  {o.color ? <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: o.color }} /> : null}
                  <span className="truncate">{o.label}</span>
                </button>
              );
            })}
            {visible.length === 0 ? (
              <p role="none" className="px-2 py-3 text-center text-xs text-ink-muted">
                Nenhuma opção com &quot;{filter.trim()}&quot;.
              </p>
            ) : null}
            {value.length ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => onChange([])}
                className="mt-1 w-full rounded-md border-t border-line px-2 py-1.5 text-left text-xs font-medium text-ink-muted outline-none hover:text-ink focus-visible:bg-surface-2 focus-visible:text-ink focus-visible:ring-2 focus-visible:ring-focus"
              >
                Limpar seleção ({value.length})
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
