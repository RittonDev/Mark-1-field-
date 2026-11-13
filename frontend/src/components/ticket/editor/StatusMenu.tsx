"use client";

import clsx from "clsx";
import { ChevronDown, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { transitionLabel } from "@/components/ticket/TransitionDialog";
import { STATUS, STATUS_ORDER } from "@/lib/constants";
import type { TicketStatus } from "@/lib/types";

/**
 * Situação da OS na barra azul do editor: pílula com o ponto na cor do status. O fundo é só um véu
 * (o branco fica acima de 4,5:1 no azul do claro e no azul forte do escuro); o hover mexe no contorno.
 */
export function StatusChip({ status, className, children }: { status: TicketStatus; className?: string; children?: React.ReactNode }) {
  const info = STATUS[status];
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap text-white ring-1 ring-white/30 ring-inset dark:bg-white/5",
        className,
      )}
    >
      <span className="size-1.5 rounded-full ring-1 ring-white/60" style={{ backgroundColor: info?.color }} aria-hidden />
      {info?.label ?? status}
      {children}
    </span>
  );
}

/**
 * A situação no cabeçalho da OS, que também é o menu para mudá-la (Agendar, Resolver, Fechar,
 * Cancelar...). Cada escolha abre a confirmação com o que o destino pede. Com alterações não
 * salvas na aba Geral, o menu explica que é preciso salvar antes.
 */
export function StatusMenu({
  status,
  targets,
  locked,
  onPick,
}: {
  status: TicketStatus;
  /** allowed_transitions da OS (a API já filtrou pelo papel de quem está logado). */
  targets: TicketStatus[];
  locked: boolean;
  onPick: (to: TicketStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = [...targets].sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b));

  useEffect(() => {
    if (!open) return;
    // Foco no primeiro item (ou no próprio menu, quando estão todos travados).
    const first = menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    (first ?? menu.current)?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      // O Esc fecha só o menu (o painel da OS fica aberto).
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    } else if (list.length && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      const next =
        e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next].focus();
    }
  };

  if (!items.length) return <StatusChip status={status} />;

  return (
    <div ref={wrap} className="relative">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Situação: ${STATUS[status].label}. Mudar a situação`}
        className="group rounded-full focus-visible:outline-white"
      >
        <StatusChip status={status} className="pr-1.5 transition-shadow group-hover:ring-white/70">
          <ChevronDown className={clsx("size-3.5 text-white/85 transition-transform duration-150", open && "rotate-180")} aria-hidden />
        </StatusChip>
      </button>
      {open ? (
        <div
          ref={menu}
          role="menu"
          tabIndex={-1}
          aria-label="Mudar a situação da OS"
          onKeyDown={onMenuKey}
          className="absolute top-full right-0 z-30 mt-2 w-64 animate-pop overflow-hidden rounded-xl border border-line bg-surface py-1.5 text-ink shadow-pop outline-none"
        >
          <p className="px-4 pt-1 pb-1.5 text-[11px] font-bold tracking-[0.06em] text-ink-muted uppercase">Mudar a situação</p>
          {locked ? (
            <p className="mx-3 mb-1.5 flex items-start gap-1.5 rounded-lg bg-surface-2 px-2.5 py-2 text-xs text-ink-muted">
              <Lock className="mt-px size-3.5 shrink-0" />
              Salve as alterações da aba Geral para mudar a situação.
            </p>
          ) : null}
          {items.map((to) => (
            <button
              key={to}
              type="button"
              role="menuitem"
              disabled={locked}
              onClick={() => {
                close(true);
                onPick(to);
              }}
              className={clsx(
                "flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors outline-none hover:bg-surface-2 focus-visible:bg-surface-2 disabled:pointer-events-none disabled:opacity-50",
                to === "cancelled" ? "text-red-700 dark:text-red-300" : "text-ink",
              )}
            >
              <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: STATUS[to].color }} aria-hidden />
              {transitionLabel(to)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
