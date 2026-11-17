"use client";

import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

/** Larguras do quadro (a classe e os pixels, para saber se cabe à direita do botão). */
const PANEL_WIDTHS = {
  sm: { className: "w-72", px: 288 },
  md: { className: "w-80", px: 320 },
  lg: { className: "w-96", px: 384 },
} as const;

export type PanelWidth = keyof typeof PANEL_WIDTHS;

const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Botão em pílula da fileira de filtros (como no Field Control); ativo, fica no tom da marca. */
export function pillClassName(active: boolean, className?: string) {
  return clsx(
    "inline-flex h-8 max-w-[18rem] items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors duration-150",
    "focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none",
    active
      ? "border-brand/50 bg-brand-soft text-brand-ink"
      : "border-line bg-surface text-ink shadow-elev-1 hover:border-line-strong hover:bg-surface-2",
    className,
  );
}

/**
 * Botão que abre um quadro com campos (um filtro, as colunas). O foco vai para o campo marcado com
 * data-autofocus (ou para o primeiro do quadro); Esc fecha e devolve o foco ao botão; clicar fora ou
 * sair com o Tab fecha. Perto da borda direita da tela o quadro abre alinhado à direita do botão.
 */
export function Popover({
  label,
  trigger,
  triggerLabel,
  triggerClassName,
  width = "md",
  children,
}: {
  /** Nome do quadro para o leitor de tela (ex.: "Filtrar por cliente"). */
  label: string;
  trigger: React.ReactNode;
  /** Nome do botão quando o texto à vista não diz tudo. */
  triggerLabel?: string;
  triggerClassName: string;
  width?: PanelWidth;
  children: (close: (focusTrigger?: boolean) => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  // Pedidos de devolver o foco ao botão (cada fechamento que pede soma um; o efeito abaixo atende).
  const [focusRequest, setFocusRequest] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const show = () => {
    const rect = button.current?.getBoundingClientRect();
    setAlignRight(!!rect && rect.left + PANEL_WIDTHS[width].px > window.innerWidth - 16);
    setOpen(true);
  };
  const close = (focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) setFocusRequest((n) => n + 1);
  };

  useEffect(() => {
    if (focusRequest) button.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    if (!open) return;
    const node = panel.current;
    (node?.querySelector<HTMLElement>("[data-autofocus]") ?? node?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div
      ref={wrap}
      className="relative"
      onKeyDown={(e) => {
        // Esc já tratado por dentro (a lista de uma busca aberta) fecha só aquela lista.
        if (e.key !== "Escape" || !open || e.isDefaultPrevented()) return;
        e.preventDefault();
        close();
      }}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (open && next && !e.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        onClick={() => (open ? close(false) : show())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={triggerLabel}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open ? (
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-label={label}
          className={clsx(
            "absolute top-full z-40 mt-1.5 w-80 max-w-[calc(100vw-2rem)] animate-pop rounded-xl border border-line bg-surface p-3 shadow-pop",
            alignRight ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

/** Filtro da fileira: "Cliente" vazio; "Cliente: Madero" com valor. */
export function FilterPopover({
  label,
  value,
  panelLabel,
  panelClassName,
  children,
}: {
  label: string;
  /** Resumo do que está escolhido (vazio: filtro sem uso). */
  value?: string | null;
  panelLabel: string;
  panelClassName?: string;
  children: (close: (focusTrigger?: boolean) => void) => React.ReactNode;
}) {
  const active = Boolean(value);
  return (
    <Popover
      label={panelLabel}
      triggerLabel={active ? `${label}: ${value}` : label}
      triggerClassName={pillClassName(active)}
      panelClassName={panelClassName}
      trigger={
        <>
          <span className="truncate">
            {label}
            {active ? <span className="font-semibold">: {value}</span> : null}
          </span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-70" />
        </>
      }
    >
      {children}
    </Popover>
  );
}
