"use client";

import { Card, CardHeader, Skeleton } from "@/components/ui";
import { useCan } from "@/lib/permissions";
import { MeterRow } from "./figures";
import { hoursText, intFmt, MIN_BASE, pctText, share } from "./rules";
import type { HomeTeam } from "./types";
import { CardLink } from "./vitals/VitalCard";

/** Com menos técnicos que isto, "os 3 maiores" é quase todo mundo e não diz nada. */
const TOP3_MIN_WORKED = 5;

/**
 * A rede de técnicos nos últimos 30 dias: quantos atenderam, quanto dependem de poucos, o app e o tempo
 * na loja. O atalho "Técnicos" só aparece para quem tem acesso à tela.
 */
export function TeamCard({ team }: { team: HomeTeam | null }) {
  const canTechnicians = useCan("base.technicians");
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Equipe de campo"
        description="Últimos 30 dias"
        actions={canTechnicians ? <CardLink href="/tecnicos">Técnicos</CardLink> : undefined}
      />
      {team === null ? (
        <div className="flex flex-col gap-4 px-5 py-4" role="status" aria-label="Carregando a equipe de campo">
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-1.5 w-full rounded-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ) : team.worked === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">Nenhuma OS resolvida por técnicos nos últimos 30 dias.</p>
      ) : (
        <TeamBody team={team} />
      )}
    </Card>
  );
}

function TeamBody({ team: t }: { team: HomeTeam }) {
  const top3 = share({ count: t.top3_resolved, base: t.resolved }, MIN_BASE);
  const over = share(t.onsite_over, MIN_BASE);
  const limit = `${t.onsite_limit_hours} h`;
  const verb = t.onsite_over.count === 1 ? "passou" : "passaram";
  const overPct = over.pct !== null ? ` (${pctText(over.pct)})` : "";
  const overText = t.onsite_over.count === 0 ? `Nenhuma passou de ${limit}` : `${over.text} ${verb} de ${limit}${overPct}`;
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div>
        <p className="text-sm text-ink tabular-nums">
          <span className="font-semibold">{intFmt(t.worked)}</span> {t.worked === 1 ? "técnico atendeu" : "técnicos atenderam"}
        </p>
        {t.worked >= TOP3_MIN_WORKED ? (
          <p className="mt-0.5 text-xs text-ink-muted tabular-nums">
            3 maiores: {top3.pct !== null ? `${pctText(top3.pct)} das OS (${top3.text})` : `${top3.text} OS`}
          </p>
        ) : null}
      </div>
      <MeterRow
        label="No app"
        ratio={{ count: t.in_app, base: t.worked }}
        min={MIN_BASE}
        title="Técnicos que atenderam e já entraram no app de campo"
      />
      {t.onsite_median_minutes !== null ? (
        <div>
          <p className="text-sm text-ink tabular-nums" title="Tempo de trabalho na loja das OS resolvidas">
            Tempo na loja: mediana <span className="font-semibold">{hoursText(t.onsite_median_minutes)}</span>
          </p>
          <p className="mt-0.5 text-xs text-ink-muted tabular-nums">{overText}</p>
        </div>
      ) : null}
    </div>
  );
}
