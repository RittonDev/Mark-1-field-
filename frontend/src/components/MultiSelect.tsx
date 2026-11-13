"use client";

import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface MultiOption {
  value: string;
  label: string;
  color?: string;
}

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
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
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

  return (
    <div
      ref={ref}
      className="relative"
      onKeyDown={(e) => {
        // Esc fecha só a lista (e não o diálogo ou o painel da OS em volta), e o foco volta ao botão.
        if (e.key !== "Escape" || !open) return;
        e.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel ? `${ariaLabel}: ${summary}` : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        className={clsx(
          "inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-surface px-3 text-sm",
          value.length ? "border-brand/50 text-ink" : "border-line text-ink-muted",
        )}
      >
        <span className="truncate">{summary}</span>
        <ChevronDown className="size-3.5 shrink-0" />
      </button>
      {open ? (
        // role="menu": a lista conta como a camada de cima (o Esc do painel e do diálogo esperam por ela).
        <div
          role="menu"
          aria-label={ariaLabel ?? label}
          className="absolute z-40 mt-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-lg"
        >
          {options.map((o) => {
            const checked = value.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                onClick={() => toggle(o.value)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-2"
              >
                <span
                  aria-hidden
                  className={clsx(
                    "flex size-4 items-center justify-center rounded border",
                    checked ? "border-brand bg-brand text-white" : "border-line",
                  )}
                >
                  {checked ? <Check className="size-3" /> : null}
                </span>
                {o.color ? <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: o.color }} /> : null}
                <span className="truncate">{o.label}</span>
              </button>
            );
          })}
          {value.length ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => onChange([])}
              className="mt-1 w-full rounded-md border-t border-line px-2 py-1.5 text-left text-xs text-ink-muted hover:text-ink"
            >
              Limpar seleção
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
