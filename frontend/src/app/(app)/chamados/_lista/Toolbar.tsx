"use client";

import clsx from "clsx";
import { ChevronDown, Columns3, Download, ListChecks, ListFilter, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { buttonClassName, isTopLayer } from "@/components/ui";
import type { ColumnsState } from "./columns";
import { EXPORT_LIMIT } from "./exportTickets";
import { Popover } from "./Popover";

export type ExportScope = "filtered" | "selected";

const countOs = (n: number) => `${n.toLocaleString("pt-BR")} OS`;

/**
 * "Exportar": a planilha do que está filtrado (todas as páginas) ou só das OS marcadas na lista. Menu
 * de teclado: abre com o foco no primeiro item; setas, Home e End andam; Esc fecha e devolve o foco.
 */
export function ExportMenu({
  total,
  selected,
  busy,
  onExport,
}: {
  /** OS no filtro de agora (null enquanto a lista carrega). */
  total: number | null;
  selected: number;
  busy: boolean;
  onExport: (scope: ExportScope) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      const node = menu.current;
      if (e.defaultPrevented || !node || !isTopLayer(node)) return;
      const list = items();
      const index = list.indexOf(document.activeElement as HTMLElement);
      const focus = (i: number) => {
        e.preventDefault();
        list[(i + list.length) % list.length]?.focus();
      };
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      } else if (e.key === "ArrowDown") focus(index + 1);
      else if (e.key === "ArrowUp") focus(index < 0 ? -1 : index - 1);
      else if (e.key === "Home") focus(0);
      else if (e.key === "End") focus(-1);
      else if (e.key === "Tab") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (scope: ExportScope) => {
    setOpen(false);
    trigger.current?.focus();
    onExport(scope);
  };
  const item =
    "flex w-full items-start gap-3 px-4 py-2.5 text-left text-sm text-ink transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none disabled:opacity-50";

  return (
    <div ref={wrap} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-busy={busy || undefined}
        className={buttonClassName("secondary")}
      >
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Download aria-hidden className="size-4" />}
        {busy ? "Exportando..." : "Exportar"}
        <ChevronDown aria-hidden className="size-3.5 text-ink-subtle" />
      </button>
      {open ? (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Exportar planilha"
          className="absolute right-0 z-40 mt-1.5 w-80 max-w-[calc(100vw-2rem)] animate-pop overflow-hidden rounded-xl border border-line bg-surface py-1.5 shadow-pop"
        >
          <button type="button" role="menuitem" tabIndex={-1} disabled={!total} onClick={() => run("filtered")} className={item}>
            <ListFilter aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
            <span className="min-w-0">
              <span className="block font-medium">Exportar o que está filtrado</span>
              <span className="block text-xs text-ink-muted">
                {total === null
                  ? "Carregando a lista..."
                  : total === 0
                    ? "Nenhuma OS com os filtros de agora"
                    : total > EXPORT_LIMIT
                      ? `As primeiras ${countOs(EXPORT_LIMIT)} de ${countOs(total)}`
                      : `${countOs(total)}, todas as páginas`}
              </span>
            </span>
          </button>
          {selected > 0 ? (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => run("selected")} className={item}>
              <ListChecks aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
              <span className="min-w-0">
                <span className="block font-medium">Exportar selecionadas</span>
                <span className="block text-xs text-ink-muted">
                  {selected === 1 ? "A OS marcada na lista" : `As ${countOs(selected)} marcadas na lista`}
                </span>
              </span>
            </button>
          ) : null}
          <p role="presentation" className="border-t border-line px-4 pt-2 pb-1 text-xs text-ink-muted">
            Planilha CSV que abre no Excel, com as colunas da lista.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** "Colunas": liga e desliga as colunas da tabela; a escolha fica salva neste navegador. */
export function ColumnsMenu({ columns }: { columns: ColumnsState }) {
  return (
    <Popover
      label="Colunas da lista"
      triggerClassName={buttonClassName("secondary")}
      width="sm"
      trigger={
        <>
          <Columns3 aria-hidden className="size-4" />
          Colunas
        </>
      }
    >
      {() => (
        <div className="flex flex-col gap-2">
          <fieldset>
            <legend className="mb-1 px-2 text-xs font-semibold text-ink/80">Colunas à vista</legend>
            <ul role="list" className="flex max-h-80 flex-col overflow-y-auto">
              <li>
                <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-muted">
                  <input type="checkbox" checked disabled className="size-4 shrink-0 accent-[var(--brand)]" />
                  Identificador
                  <span className="ml-auto text-xs">sempre</span>
                </label>
              </li>
              {columns.available.map((c) => (
                <li key={c.key}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink transition-colors hover:bg-surface-2">
                    <input
                      type="checkbox"
                      checked={columns.isVisible(c.key)}
                      onChange={() => columns.toggle(c.key)}
                      className="size-4 shrink-0 accent-[var(--brand)]"
                    />
                    {c.label}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <div className="flex items-center justify-between gap-2 border-t border-line px-2 pt-2">
            <span className="text-xs text-ink-muted">Fica salvo neste navegador.</span>
            <button
              type="button"
              onClick={columns.reset}
              disabled={columns.isDefault}
              className={clsx(buttonClassName("ghost", "sm"), "-mr-2")}
            >
              Restaurar padrão
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}
