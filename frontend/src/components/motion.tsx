"use client";

import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef } from "react";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const defaultFormat = (n: number) => Math.round(n).toLocaleString("pt-BR");

/** Número que "conta" até o valor (indicadores). Atualiza o texto direto no DOM, sem re-render. */
export function CountUp({
  value,
  format,
  duration = 500,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
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
      {(format ?? defaultFormat)(0)}
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
 */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  variant = "underline",
  className,
  ariaLabel,
}: {
  items: TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  variant?: "underline" | "segmented";
  className?: string;
  ariaLabel?: string;
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
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [value, keys, variant]);

  const segmented = variant === "segmented";
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={ariaLabel}
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
            aria-selected={active}
            data-tab={item.key}
            onClick={() => onChange(item.key)}
            className={clsx(
              "relative z-10 inline-flex items-center gap-1.5 text-sm whitespace-nowrap transition-colors",
              segmented ? "h-7 rounded-md px-3 text-[13px]" : "px-3 pt-1 pb-2.5",
              active ? "font-medium text-ink" : "text-ink-muted hover:text-ink",
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
