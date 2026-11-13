"use client";

import clsx from "clsx";
import { Clock3, Hourglass, MapPinCheck, RotateCcw } from "lucide-react";
import { useNow } from "@/components/useNow";
import { formatMinutes, formatTime } from "@/lib/format";
import type { TicketListItem } from "@/lib/types";

type Clockable = Pick<
  TicketListItem,
  "arrival_due_at" | "arrived_at" | "onsite_due_at" | "arrival_status" | "onsite_status" | "status"
>;

const minutesBetween = (a: number, b: number) => Math.round((b - a) / 60_000);

/** Prazo de chegada à loja (4h nas capitais): "Chegar até 14:35 · faltam 52 min" ou "Chegou 13:42 · no prazo". */
export function ArrivalChip({ ticket, compact = false }: { ticket: Clockable; compact?: boolean }) {
  const now = useNow(30_000);
  if (!ticket.arrival_due_at && !ticket.arrived_at) return null;
  if (ticket.arrived_at) {
    const late = ticket.arrival_status === "late";
    return (
      <span
        className={clsx(
          "inline-flex items-center gap-1 text-xs whitespace-nowrap",
          late ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400",
        )}
        title={ticket.arrival_due_at ? `Prazo de chegada: ${formatTime(ticket.arrival_due_at)}` : undefined}
      >
        <MapPinCheck className="size-3.5" />
        Chegou {formatTime(ticket.arrived_at)}
        {compact ? null : late ? " · com atraso" : " · no prazo"}
      </span>
    );
  }
  if (!ticket.arrival_due_at) return null;
  const left = minutesBetween(now, new Date(ticket.arrival_due_at).getTime());
  const late = left < 0;
  const risk = !late && (ticket.arrival_status === "at_risk" || left <= 60);
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap",
        late ? "text-red-600 dark:text-red-400" : risk ? "text-amber-700 dark:text-amber-400" : "text-ink-muted",
      )}
      title="Prazo para o técnico chegar à loja"
    >
      <Clock3 className="size-3.5" />
      {late
        ? `Chegada atrasada ${formatMinutes(-left)}`
        : `Chegar até ${formatTime(ticket.arrival_due_at)}${compact ? "" : ` · faltam ${formatMinutes(left)}`}`}
    </span>
  );
}

/** Tempo na loja contra o limite do chamado (4h a partir da chegada). */
export function OnsiteBar({ ticket, className }: { ticket: Clockable; className?: string }) {
  const now = useNow(30_000);
  if (!ticket.arrived_at || !ticket.onsite_due_at) return null;
  if (!["in_progress", "on_hold_customer", "on_hold_vendor", "en_route"].includes(ticket.status)) return null;
  const start = new Date(ticket.arrived_at).getTime();
  const end = new Date(ticket.onsite_due_at).getTime();
  const total = Math.max(1, end - start);
  const elapsed = Math.max(0, now - start);
  const ratio = Math.min(1, elapsed / total);
  const left = minutesBetween(now, end);
  const over = left < 0 || ticket.onsite_status === "over";
  const warning = !over && ticket.onsite_status === "warning";
  return (
    <div className={clsx("min-w-36", className)} title="Tempo do técnico na loja (limite do chamado)">
      {/* Em coluna estreita quebra entre as duas partes, nunca no meio de um tempo. */}
      <div
        className={clsx(
          "mb-1 flex flex-wrap items-center gap-x-1 text-[11px] font-medium",
          over ? "text-red-600 dark:text-red-400" : warning ? "text-amber-700 dark:text-amber-400" : "text-ink-muted",
        )}
      >
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <Hourglass className="size-3" />
          {formatMinutes(Math.round(elapsed / 60_000))} na loja
        </span>
        <span className="text-ink-subtle">·</span>
        <span className="whitespace-nowrap">{over ? `passou ${formatMinutes(-left)}` : `restam ${formatMinutes(left)}`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className={clsx(
            "h-full rounded-full transition-[width] duration-700",
            over ? "bg-red-500" : warning ? "bg-amber-500" : "bg-brand",
          )}
          style={{ width: `${Math.max(4, ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** Reincidência: outras OS na mesma loja nos últimos 30 dias. */
export function RecurrenceChip({ count }: { count?: number }) {
  if (!count) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-violet-700 ring-1 ring-violet-200 ring-inset dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/25"
      title="Outras OS nesta loja nos últimos 30 dias"
    >
      <RotateCcw className="size-3" />
      {count === 1 ? "1 OS na loja em 30 dias" : `${count} OS na loja em 30 dias`}
    </span>
  );
}
