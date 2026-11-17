"use client";

import { ArrowRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import { RankBars, type RankItem } from "@/components/charts";
import { revealSection } from "@/components/operacao/hooks";
import { ticketsListHref } from "./links";
import { dayMonth, intFmt } from "./rules";
import type { HomeBacklog } from "./types";

export const OLD_BACKLOG_ID = "fila-antiga";

/** Abre a "Fila antiga" e rola até ela (o "189 antes disso" da Fila em aberto). */
export function revealOldBacklog(): boolean {
  const el = document.getElementById(OLD_BACKLOG_ID);
  if (!(el instanceof HTMLDetailsElement)) return false;
  el.open = true;
  revealSection(el.querySelector("summary") ?? el);
  return true;
}

/**
 * O resíduo das OS abertas antes dos últimos 30 dias (quase todo do Field Control), fora de "Agora" e
 * "Rotina": fechado, com os motivos e a lista de cada um para triar.
 */
export function OldBacklog({ backlog, windowFrom }: { backlog: HomeBacklog; windowFrom: string }) {
  if (backlog.old <= 0) return null;
  const reasons = backlog.old_reasons.map((r) => ({ id: r.key, name: r.label, count: r.count }));
  const hrefOf = (item: RankItem) => {
    const filters = backlog.old_reasons.find((r) => r.key === item.id)?.filters;
    return filters ? ticketsListHref(filters) : undefined;
  };
  return (
    <details id={OLD_BACKLOG_ID} className="group scroll-mt-20 rounded-xl border border-line bg-surface shadow-elev-1">
      <summary className="flex scroll-mt-20 cursor-pointer list-none items-center gap-2.5 rounded-xl px-5 py-3.5 select-none [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full bg-linear-to-b from-brand to-brand-cyan" />
        <span className="min-w-0 flex-1 text-[15px] leading-5 font-bold tracking-[-0.01em] text-ink">
          Fila antiga
          <span className="text-sm font-normal tracking-normal text-ink-muted tabular-nums">
            {" "}
            · {intFmt(backlog.old)} OS abertas antes de {dayMonth(windowFrom)}
          </span>
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-ink-subtle transition-transform duration-150 group-open:rotate-180" />
      </summary>
      <div className="border-t border-line px-5 py-4">
        <RankBars items={reasons} empty="Nenhum motivo em destaque." href={hrefOf} label="Motivos da fila antiga" />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-xs text-ink-muted">
          <span>Uma OS pode ter mais de um motivo.</span>
          <Link
            href={ticketsListHref(backlog.old_filters)}
            className="inline-flex items-center gap-1 font-semibold text-brand-ink underline-offset-2 hover:underline"
          >
            Abrir da mais antiga
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      </div>
    </details>
  );
}
