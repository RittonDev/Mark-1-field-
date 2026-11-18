"use client";

import clsx from "clsx";
import { Clock3, Hourglass, MapPinCheck, RotateCcw } from "lucide-react";
import { useNow } from "@/components/useNow";
import { formatMinutes, formatTime } from "@/lib/format";
import type { TicketListItem } from "@/lib/types";

type Clockable = Pick<
  TicketListItem,
  "arrival_due_at" | "arrived_at" | "onsite_due_at" | "arrival_status" | "onsite_status" | "status" | "work_started_at"
>;

const minutesBetween = (a: number, b: number) => Math.round((b - a) / 60_000);

/** O relógio de campo numa linha (variante compacta do cabeçalho da OS). */
export interface FieldClockSummary {
  /** "route": a caminho da loja; "store": em atendimento na loja. */
  kind: "route" | "store";
  text: string;
  /** Cor só no aviso (âmbar) e no estouro (vermelho). */
  tone: "neutral" | "warning" | "danger";
  title: string;
}

/**
 * Variante compacta do relógio de campo, só com a OS em campo (a caminho ou em atendimento):
 * "A caminho · chegar até 14:35" e "Na loja há 1h 10min · limite 4h". A saída para o local não vem na
 * OS (está no histórico), então a caminho conta o prazo de chegada. Na loja, o tempo é o da visita em
 * curso e o limite é o que ela pode durar (o que sobrou das horas do chamado).
 */
export function fieldClockSummary(ticket: Clockable, now: number): FieldClockSummary | null {
  if (ticket.status === "en_route") {
    if (ticket.arrived_at || !ticket.arrival_due_at) {
      return { kind: "route", tone: "neutral", text: "A caminho", title: "Técnico a caminho do local" };
    }
    const left = minutesBetween(now, new Date(ticket.arrival_due_at).getTime());
    const title = `Prazo de chegada à loja: ${formatTime(ticket.arrival_due_at)}`;
    if (left < 0) return { kind: "route", tone: "danger", text: `A caminho · chegada atrasada ${formatMinutes(-left)}`, title };
    const risk = ticket.arrival_status === "at_risk" || left <= 60;
    return {
      kind: "route",
      tone: risk ? "warning" : "neutral",
      text: `A caminho · chegar até ${formatTime(ticket.arrival_due_at)}`,
      title,
    };
  }
  if (ticket.status !== "in_progress") return null;
  const since = ticket.work_started_at ?? ticket.arrived_at;
  if (!since) return { kind: "store", tone: "neutral", text: "Em atendimento", title: "Técnico em atendimento na loja" };
  const start = new Date(since).getTime();
  const due = ticket.onsite_due_at ? new Date(ticket.onsite_due_at).getTime() : null;
  const elapsed = Math.max(0, minutesBetween(start, now));
  const limit = due !== null ? Math.max(0, minutesBetween(start, due)) : null;
  const over = (due !== null && now > due) || ticket.onsite_status === "over";
  const warning = !over && ticket.onsite_status === "warning";
  return {
    kind: "store",
    tone: over ? "danger" : warning ? "warning" : "neutral",
    text: `Na loja há ${formatMinutes(elapsed)}${limit !== null ? ` · limite ${formatMinutes(limit)}` : ""}`,
    title: ticket.onsite_due_at
      ? `Tempo do técnico na loja: limite às ${formatTime(ticket.onsite_due_at)}`
      : "Tempo do técnico na loja nesta visita",
  };
}

/** Prazo de chegada à loja (Configurações › Campo): "Chegar até 14:35 · faltam 52 min" ou "Chegou 13:42 · no prazo". */
export function ArrivalChip({ ticket, compact = false }: { ticket: Clockable; compact?: boolean }) {
  const now = useNow(30_000);
  if (!ticket.arrival_due_at && !ticket.arrived_at) return null;
  if (ticket.arrived_at) {
    const late = ticket.arrival_status === "late";
    // Cor só no atraso: chegar no prazo é o normal e fica neutro.
    return (
      <span
        className={clsx(
          "inline-flex items-center gap-1 text-xs whitespace-nowrap",
          late ? "font-medium text-red-600 dark:text-red-400" : "text-ink-muted",
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

/**
 * Tempo na loja na visita em curso contra o que ela pode durar (o que sobrou das horas do chamado).
 * Só em atendimento, como o onsite_status da API: fora da loja (a caminho, aguardando peça) não corre.
 */
export function OnsiteBar({ ticket, className }: { ticket: Clockable; className?: string }) {
  const now = useNow(30_000);
  const since = ticket.work_started_at ?? ticket.arrived_at;
  if (ticket.status !== "in_progress" || !since || !ticket.onsite_due_at) return null;
  const start = new Date(since).getTime();
  const end = new Date(ticket.onsite_due_at).getTime();
  const total = Math.max(1, end - start);
  const elapsed = Math.max(0, now - start);
  const ratio = Math.min(1, elapsed / total);
  const left = minutesBetween(now, end);
  const over = left < 0 || ticket.onsite_status === "over";
  const warning = !over && ticket.onsite_status === "warning";
  return (
    <div className={clsx("min-w-28", className)} title="Tempo do técnico na loja (limite do chamado)">
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
            "h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
            over ? "bg-red-500" : warning ? "bg-amber-500" : "bg-brand",
          )}
          style={{ width: `${Math.max(4, ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Reincidência: outras OS na mesma loja nos últimos 30 dias. Uma é comum (fica neutra); duas ou
 * mais indicam problema que volta, e aí o selo fica em âmbar.
 */
export function RecurrenceChip({ count }: { count?: number }) {
  if (!count) return null;
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset",
        count >= 2
          ? "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25"
          : "bg-surface-2 text-ink-muted ring-line",
      )}
      title="Outras OS nesta loja nos últimos 30 dias"
    >
      <RotateCcw className="size-3" />
      {count === 1 ? "1 OS na loja em 30 dias" : `${count} OS na loja em 30 dias`}
    </span>
  );
}
