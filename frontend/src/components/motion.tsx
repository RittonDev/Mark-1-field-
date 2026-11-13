"use client";

import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const defaultFormat = (n: number) => Math.round(n).toLocaleString("pt-BR");

/**
 * Indicador que muda: ao abrir a tela mostra o valor direto (sem contar do zero a cada visita); quando
 * o número muda com a tela aberta, anda até o novo valor em 0,3 s, para o olho notar a mudança.
 * Atualiza o texto direto no DOM, sem re-render.
 */
export function CountUp({
  value,
  format,
  duration = 300,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  // O texto do React fica com o valor da abertura; dali em diante quem escreve é o efeito.
  const [initial] = useState(value);
  const shown = useRef(value);
  const fmt = useRef(format ?? defaultFormat);
  useEffect(() => {
    fmt.current = format ?? defaultFormat;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current;
    const to = value;
    if (from === to || reducedMotion()) {
      shown.current = to;
      el.textContent = fmt.current(to);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = p >= 1 ? 1 : 1 - Math.pow(2, -10 * p);
      const current = from + (to - from) * eased;
      shown.current = current;
      el.textContent = fmt.current(current);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return (
    <span ref={ref} className={clsx("tabular-nums", className)}>
      {(format ?? defaultFormat)(initial)}
    </span>
  );
}

export interface TabItem<K extends string> {
  key: K;
  label: React.ReactNode;
  /** Contador ao lado do rótulo (null/undefined: sem contador). */
  count?: number | null;
}

/**
 * Abas com indicador que desliza até a aba ativa.
 * "underline": linha da marca embaixo (vistas de uma página). "segmented": pílula sobre trilho cinza.
 * Teclado no padrão de abas: só a ativa entra no Tab; setas, Home e End trocam de aba.
 */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  variant = "underline",
  className,
  ariaLabel,
  idPrefix,
}: {
  items: TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  variant?: "underline" | "segmented";
  className?: string;
  ariaLabel?: string;
  /** Liga cada aba ao seu painel: a aba recebe id "<prefixo>-tab-<chave>" e aponta para "<prefixo>-panel-<chave>". */
  idPrefix?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  const keys = items.map((i) => i.key).join("|");

  useLayoutEffect(() => {
    const root = list.current;
    const ind = indicator.current;
    if (!root || !ind) return;
    const inset = variant === "underline" ? 8 : 0;
    const measure = () => {
      const el = root.querySelector<HTMLElement>(`[data-tab="${CSS.escape(value)}"]`);
      if (!el) {
        ind.style.opacity = "0";
        return;
      }
      ind.style.opacity = "1";
      ind.style.width = `${Math.max(0, el.offsetWidth - inset * 2)}px`;
      ind.style.transform = `translateX(${el.offsetLeft + inset}px)`;
    };
    if (!placed.current) {
      // Primeira posição sem animação (não "voa" do canto).
      ind.style.transition = "none";
      measure();
      void ind.offsetWidth;
      ind.style.transition = "";
      placed.current = true;
    } else {
      measure();
    }
    // Aba ativa fora da área visível (celular, muitas abas): rola só a fileira de abas, nunca a página.
    const active = root.querySelector<HTMLElement>(`[data-tab="${CSS.escape(value)}"]`);
    if (active && root.scrollWidth > root.clientWidth) {
      if (active.offsetLeft < root.scrollLeft) root.scrollLeft = Math.max(0, active.offsetLeft - 8);
      else if (active.offsetLeft + active.offsetWidth > root.scrollLeft + root.clientWidth) {
        root.scrollLeft = active.offsetLeft + active.offsetWidth - root.clientWidth + 8;
      }
    }
    // A lista e cada aba: o contador que chega depois alarga a aba sem mudar o tamanho da lista.
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    root.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [value, keys, variant]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    const index = items.findIndex((i) => i.key === value);
    let next: number;
    if (e.key === "ArrowRight") next = (index + 1) % items.length;
    else if (e.key === "ArrowLeft") next = index <= 0 ? items.length - 1 : index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    const key = items[next].key;
    if (key !== value) onChange(key);
    list.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(key)}"]`)?.focus();
  };

  // Sem aba ativa na lista, a primeira recebe o Tab.
  const focusKey = items.some((i) => i.key === value) ? value : items[0]?.key;
  const segmented = variant === "segmented";
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={clsx(
        "relative flex",
        segmented ? "gap-0.5 rounded-lg bg-surface-3/70 p-0.5" : "gap-1 overflow-x-auto overflow-y-hidden",
        className,
      )}
    >
      <span
        ref={indicator}
        aria-hidden
        className={clsx(
          "pointer-events-none absolute left-0 transition-[transform,width,opacity] duration-200 ease-out-expo",
          segmented
            ? "inset-y-0.5 rounded-md bg-surface shadow-elev-1 ring-1 ring-line"
            : "brand-gradient bottom-0 h-0.5 rounded-full",
        )}
      />
      {items.map((item) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${item.key}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${item.key}` : undefined}
            aria-selected={active}
            tabIndex={item.key === focusKey ? 0 : -1}
            data-tab={item.key}
            onClick={() => onChange(item.key)}
            className={clsx(
              "relative z-10 inline-flex items-center gap-1.5 text-sm whitespace-nowrap transition-colors",
              segmented ? "h-7 rounded-md px-3 text-[13px]" : "px-3 pt-1 pb-2.5",
              active ? "font-semibold text-ink" : "font-medium text-ink-muted hover:text-ink",
            )}
          >
            {item.label}
            {item.count !== undefined && item.count !== null ? (
              <span
                className={clsx(
                  "rounded-full px-1.5 text-[11px] leading-[18px] font-semibold tabular-nums transition-colors",
                  active ? "bg-brand-soft text-brand-ink" : "bg-surface-3 text-ink-muted",
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
