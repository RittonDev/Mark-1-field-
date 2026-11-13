"use client";

import clsx from "clsx";
import type { LucideIcon } from "lucide-react";

/**
 * Escolha única em botões lado a lado (ex.: origem do chamado, analista responsável). Um só ponto de
 * Tab no grupo; as setas trocam a opção, como num grupo de rádio.
 */
export function SegmentedRadio<K extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  labelledBy,
  id,
  className,
}: {
  options: { value: K; label: string; icon?: LucideIcon }[];
  value: K;
  onChange: (value: K) => void;
  ariaLabel: string;
  /** id do rótulo visível (no lugar do aria-label). */
  labelledBy?: string;
  id?: string;
  className?: string;
}) {
  const checkedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  return (
    <div
      id={id}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : ariaLabel}
      className={clsx("grid gap-1 rounded-lg bg-surface-2 p-1", className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map(({ value: key, label, icon: Icon }, i) => {
        const checked = key === value;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === checkedIndex ? 0 : -1}
            onClick={() => onChange(key)}
            onKeyDown={(e) => {
              const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = (i + step + options.length) % options.length;
              onChange(options[next].value);
              e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
            }}
            className={clsx(
              "inline-flex h-8 min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors",
              "focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none",
              checked ? "bg-surface text-ink shadow-elev-1 ring-1 ring-line" : "text-ink-muted hover:text-ink",
            )}
          >
            {Icon ? <Icon aria-hidden className="size-3.5 shrink-0" /> : null}
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
