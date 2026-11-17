"use client";

import clsx from "clsx";
import { AlarmClock, CalendarClock, CheckCircle2, Inbox, Navigation, UserX } from "lucide-react";
import Link from "next/link";
import { CountUp } from "@/components/motion";
import { Skeleton } from "@/components/ui";
import { ticketsListHref } from "./links";
import type { HomeKpis } from "./types";

type Tone = "danger" | "warning";

const TONE: Record<Tone, { box: string; icon: string; value: string }> = {
  danger: {
    box: "border-red-200 dark:border-red-500/30",
    icon: "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400",
    value: "text-red-600 dark:text-red-400",
  },
  warning: {
    box: "border-amber-200 dark:border-amber-500/30",
    icon: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
    value: "text-amber-700 dark:text-amber-400",
  },
};

/**
 * Indicador do topo (o mesmo desenho da Minha fila). Com valor, leva ao que conta; com zero, é só o
 * número, sem cara de botão. Cor só quando o número sinaliza problema.
 */
function Kpi({
  label,
  hint,
  value,
  icon: Icon,
  tone,
  index,
  href,
  onClick,
}: {
  label: string;
  hint: string;
  /** null enquanto carrega. */
  value: number | null;
  icon: React.ComponentType<{ className?: string }>;
  tone?: Tone;
  index: number;
  href?: string;
  onClick?: () => void;
}) {
  const problem = tone && value !== null && value > 0 ? TONE[tone] : null;
  const interactive = value !== null && value > 0 && Boolean(href || onClick);
  const className = clsx(
    "flex min-w-0 items-center gap-3 rounded-xl border bg-surface p-4 text-left shadow-elev-1",
    interactive &&
      "transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-elev-2 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none",
    problem ? problem.box : "border-line",
  );
  const style = { ["--i" as string]: index };
  const body = (
    <>
      <span
        aria-hidden
        className={clsx("flex size-10 shrink-0 items-center justify-center rounded-xl", problem ? problem.icon : "bg-surface-2 text-ink-muted")}
      >
        <Icon className="size-5" />
      </span>
      <span className="min-w-0">
        {value === null ? (
          <Skeleton className="h-6 w-10" />
        ) : (
          <CountUp
            value={value}
            duration={300}
            className={clsx("block text-2xl leading-none font-bold tracking-tight", problem ? problem.value : "text-ink")}
          />
        )}
        <span className="mt-1 block truncate text-xs leading-snug font-semibold text-ink/80" title={hint}>
          {label}
        </span>
      </span>
    </>
  );
  if (interactive && href) {
    return (
      <Link href={href} className={className} style={style} title={hint}>
        {body}
      </Link>
    );
  }
  if (interactive && onClick) {
    return (
      <button type="button" onClick={onClick} className={className} style={style} title={hint}>
        {body}
      </button>
    );
  }
  return (
    <div className={className} style={style} title={hint}>
      {body}
    </div>
  );
}

/** Os 6 números do momento. "Atrasadas" leva aos pontos de atenção, onde está o porquê de cada uma. */
export function KpiRow({ kpis, onShowLate }: { kpis: HomeKpis | null; onShowLate: () => void }) {
  return (
    <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" aria-busy={kpis === null || undefined}>
      <Kpi
        index={0}
        label="Em aberto"
        hint="OS ainda não resolvidas"
        value={kpis?.open ?? null}
        icon={Inbox}
        href={ticketsListHref({ open_only: true })}
      />
      <Kpi index={1} label="Agendadas hoje" hint="Visitas marcadas para hoje" value={kpis?.scheduled_today ?? null} icon={CalendarClock} href="/dia" />
      <Kpi
        index={2}
        label="Em campo agora"
        hint="Técnico a caminho ou atendendo"
        value={kpis?.in_field_now ?? null}
        icon={Navigation}
        href={ticketsListHref({ status: ["en_route", "in_progress"] })}
      />
      <Kpi index={3} label="Resolvidas hoje" hint="Resolvidas desde a meia-noite" value={kpis?.resolved_today ?? null} icon={CheckCircle2} />
      <Kpi
        index={4}
        label="Atrasadas"
        hint="Prazo ou horário de chegada estourado (veja os pontos de atenção)"
        value={kpis?.late ?? null}
        icon={AlarmClock}
        tone="danger"
        onClick={onShowLate}
      />
      <Kpi
        index={5}
        label="Sem técnico"
        hint="Em aberto, ainda sem técnico"
        value={kpis?.unassigned ?? null}
        icon={UserX}
        tone="warning"
        href={ticketsListHref({ unassigned: true, open_only: true })}
      />
    </div>
  );
}
