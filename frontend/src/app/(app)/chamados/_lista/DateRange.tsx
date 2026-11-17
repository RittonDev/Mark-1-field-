"use client";

// Período de/até (criação e agendamento da OS): dias "AAAA-MM-DD" no fuso da operação, os dois
// extremos incluídos, como a API filtra.

import { useId, useState } from "react";
import { Button, Input } from "@/components/ui";
import { formatDate, todayISO } from "@/lib/format";
import { isDay } from "./params";

export interface DayRange {
  from: string;
  to: string;
}

/** Soma dias a "AAAA-MM-DD" (pode ser negativo). */
function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Primeiro dia do mês de `day`, `months` meses antes ou depois. */
function monthStart(day: string, months = 0): string {
  const [y, m] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10);
}

export interface RangePreset {
  label: string;
  /** Recebe o dia de hoje (fuso da operação) e devolve o período. */
  range: (today: string) => DayRange;
}

export const CREATED_PRESETS: RangePreset[] = [
  { label: "Hoje", range: (t) => ({ from: t, to: t }) },
  { label: "Ontem", range: (t) => ({ from: shiftDay(t, -1), to: shiftDay(t, -1) }) },
  { label: "Últimos 7 dias", range: (t) => ({ from: shiftDay(t, -6), to: t }) },
  { label: "Últimos 30 dias", range: (t) => ({ from: shiftDay(t, -29), to: t }) },
  { label: "Este mês", range: (t) => ({ from: monthStart(t), to: t }) },
  { label: "Mês passado", range: (t) => ({ from: monthStart(t, -1), to: shiftDay(monthStart(t), -1) }) },
];

export const SCHEDULED_PRESETS: RangePreset[] = [
  { label: "Hoje", range: (t) => ({ from: t, to: t }) },
  { label: "Amanhã", range: (t) => ({ from: shiftDay(t, 1), to: shiftDay(t, 1) }) },
  { label: "Próximos 7 dias", range: (t) => ({ from: t, to: shiftDay(t, 6) }) },
  { label: "Ontem", range: (t) => ({ from: shiftDay(t, -1), to: shiftDay(t, -1) }) },
  { label: "Este mês", range: (t) => ({ from: monthStart(t), to: shiftDay(monthStart(t, 1), -1) }) },
];

/** "01/11/2026 a 16/11/2026", "desde 01/11/2026", "até 16/11/2026" (vazio sem período). */
export function rangeLabel(range: DayRange): string {
  if (range.from && range.to) return range.from === range.to ? formatDate(range.from) : `${formatDate(range.from)} a ${formatDate(range.to)}`;
  if (range.from) return `desde ${formatDate(range.from)}`;
  if (range.to) return `até ${formatDate(range.to)}`;
  return "";
}

/**
 * Período com atalhos (um clique aplica) e as duas datas, que valem ao clicar em "Aplicar" (ou Enter):
 * a data digitada aos poucos não dispara uma busca a cada número.
 */
export function DateRangeForm({
  value,
  onApply,
  presets,
  legend,
  autoFocus = false,
}: {
  value: DayRange;
  onApply: (range: DayRange) => void;
  presets: RangePreset[];
  /** Nome do período para o leitor de tela (ex.: "Data de criação"). */
  legend: string;
  autoFocus?: boolean;
}) {
  const ids = { from: useId(), to: useId(), error: useId() };
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const [error, setError] = useState<string | null>(null);
  const empty = !value.from && !value.to;
  const changed = from !== value.from || to !== value.to;

  const apply = () => {
    if ((from && !isDay(from)) || (to && !isDay(to))) return setError("Confira as datas: alguma está incompleta.");
    if (from && to && from > to) return setError("A data inicial é depois da final.");
    setError(null);
    onApply({ from, to });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
      className="flex flex-col gap-3"
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">{legend}</legend>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Atalhos">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                const range = p.range(todayISO());
                setFrom(range.from);
                setTo(range.to);
                setError(null);
                onApply(range);
              }}
              className="h-7 rounded-full border border-line bg-surface px-2.5 text-xs font-medium text-ink transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label htmlFor={ids.from} className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-ink/80">De</span>
            <Input
              id={ids.from}
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? ids.error : undefined}
              data-autofocus={autoFocus || undefined}
            />
          </label>
          <label htmlFor={ids.to} className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-ink/80">Até</span>
            <Input
              id={ids.to}
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? ids.error : undefined}
            />
          </label>
        </div>
      </fieldset>
      {error ? (
        <p id={ids.error} role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        {!empty ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFrom("");
              setTo("");
              setError(null);
              onApply({ from: "", to: "" });
            }}
          >
            Limpar
          </Button>
        ) : null}
        <Button type="submit" size="sm" variant="primary" disabled={!changed}>
          Aplicar
        </Button>
      </div>
    </form>
  );
}
