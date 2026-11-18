"use client";

import { UserX } from "lucide-react";
import Link from "next/link";
import { CountUp } from "@/components/motion";
import { useCan } from "@/lib/permissions";
import { actionLink, mutedLink, ProblemText, SegmentBar, type SegmentPart, SwatchLegend, TRACK } from "../figures";
import { ticketsListHref } from "../links";
import { intFmt, plural } from "../rules";
import type { HomeToday, HomeTomorrow } from "../types";
import { VitalCard } from "./VitalCard";

/** "Sem início": a mesma regra do número do topo. */
const NOT_STARTED_HINT = "30 min ou mais depois do horário, sem sair nem começar";

/**
 * Sinal vital 1: como anda o dia (visitas de hoje) e como está montado o de amanhã. Os atalhos para
 * Atividades do dia e Calendário só aparecem para quem tem acesso a essas telas.
 */
export function TodayCard({ today, tomorrow }: { today: HomeToday | null; tomorrow: HomeTomorrow | null }) {
  const canDay = useCan("operation.day");
  return (
    <VitalCard
      title="Hoje"
      action={canDay ? { href: "/dia", label: "Abrir o dia" } : undefined}
      loading={today === null || tomorrow === null}
      footer={tomorrow ? <Tomorrow tomorrow={tomorrow} /> : null}
    >
      {today ? <TodayBody today={today} /> : null}
    </VitalCard>
  );
}

function TodayBody({ today }: { today: HomeToday }) {
  const canCalendar = useCan("operation.calendar");
  const resolved = <span>{plural(today.resolved, "OS resolvida hoje", "OS resolvidas hoje")}</span>;
  if (today.planned === 0) {
    return (
      <>
        <p className="text-sm text-ink-muted">Nenhuma visita marcada para hoje</p>
        {canCalendar ? (
          <p className="text-xs">
            <Link href="/agenda" className={actionLink}>
              Abrir agenda
            </Link>
          </p>
        ) : null}
        {today.resolved > 0 ? <p className="text-xs text-ink-muted tabular-nums">{resolved}</p> : null}
      </>
    );
  }
  // Na ordem da barra; "Aguardando" só aparece quando há; o resto ("A seguir") é o trilho.
  const parts: SegmentPart[] = [
    { key: "done", label: "Concluídas", value: today.done, color: "var(--viz-2)" },
    { key: "in_field", label: "Em campo", value: today.in_field, color: "var(--viz-1)" },
    { key: "not_started", label: "Sem início", value: today.not_started, color: "#d97706", title: NOT_STARTED_HINT },
    ...(today.on_hold > 0 ? [{ key: "on_hold", label: "Aguardando", value: today.on_hold, color: "var(--ink-subtle)" }] : []),
    { key: "upcoming", label: "A seguir", value: today.upcoming, color: TRACK },
  ];
  const spoken = [
    plural(today.done, "concluída", "concluídas"),
    `${intFmt(today.in_field)} em campo`,
    `${intFmt(today.not_started)} sem início`,
    ...(today.on_hold > 0 ? [`${intFmt(today.on_hold)} aguardando`] : []),
    `${intFmt(today.upcoming)} a seguir`,
  ].join(", ");
  return (
    <>
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[28px] leading-none font-semibold tracking-[-0.02em] text-ink">
          <CountUp value={today.done} tabular={false} /> de {intFmt(today.planned)}
        </span>
        <span className="text-sm text-ink-muted">{today.planned === 1 ? "visita concluída" : "visitas concluídas"}</span>
      </p>
      <div className="flex flex-col gap-2">
        <SegmentBar parts={parts} label={`Visitas de hoje: ${spoken}`} />
        <SwatchLegend parts={parts} />
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted tabular-nums">
        <span>{plural(today.technicians, "técnico com visita", "técnicos com visita")}</span>
        {today.unassigned > 0 ? (
          <ProblemText tone="warning" icon={UserX} href={ticketsListHref(today.unassigned_filters)} title="Visitas de hoje sem técnico">
            {intFmt(today.unassigned)} sem técnico
          </ProblemText>
        ) : today.planned > 1 ? (
          <span>todas com técnico</span>
        ) : null}
        {resolved}
      </p>
    </>
  );
}

/** Rodapé: o dia seguinte (visitas, técnicos e o buraco de quem não tem técnico). */
function Tomorrow({ tomorrow }: { tomorrow: HomeTomorrow }) {
  const canDay = useCan("operation.day");
  const canCalendar = useCan("operation.calendar");
  if (tomorrow.planned === 0) {
    return (
      <p className="flex flex-wrap gap-x-2">
        <span>Amanhã: nada marcado</span>
        {canCalendar ? (
          <Link href="/agenda" className={actionLink}>
            Abrir agenda
          </Link>
        ) : null}
      </p>
    );
  }
  const head = [
    `Amanhã: ${plural(tomorrow.planned, "visita", "visitas")}`,
    ...(tomorrow.technicians > 0 ? [plural(tomorrow.technicians, "técnico", "técnicos")] : []),
    ...(tomorrow.unassigned > 0 || tomorrow.planned < 2 ? [] : ["todas com técnico"]),
  ].join(" · ");
  return (
    <p className="tabular-nums">
      {canDay ? (
        <Link href={`/dia?d=${tomorrow.day}`} className={mutedLink}>
          {head}
        </Link>
      ) : (
        <span>{head}</span>
      )}
      {tomorrow.unassigned > 0 ? (
        <>
          {" · "}
          <ProblemText
            tone="warning"
            icon={UserX}
            href={ticketsListHref(tomorrow.unassigned_filters)}
            title="Visitas de amanhã sem técnico"
          >
            {intFmt(tomorrow.unassigned)} sem técnico
          </ProblemText>
        </>
      ) : null}
    </p>
  );
}
