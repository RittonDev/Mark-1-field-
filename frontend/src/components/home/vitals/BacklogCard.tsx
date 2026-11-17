"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { RankBars, type RankItem } from "@/components/charts";
import { CountUp } from "@/components/motion";
import { mutedLink, ProblemText } from "../figures";
import { ticketsListHref } from "../links";
import { OLD_BACKLOG_ID, revealOldBacklog } from "../OldBacklog";
import { AGE_LABEL, growthLimit, intFmt, MIN_BASE, plural, signed } from "../rules";
import type { HomeBacklog } from "../types";
import { VitalCard } from "./VitalCard";

const BALANCE_HINT = "Entraram − resolvidas − canceladas nos últimos 30 dias";

/** "mediana de 74 dias"; abaixo de 1 dia, "menos de 1 dia". */
function medianText(days: number): string {
  return days < 1 ? "mediana de menos de 1 dia" : `mediana de ${plural(Math.round(days), "dia", "dias")}`;
}

/** Sinal vital 2: o tamanho da fila, a idade dela e se está crescendo. */
export function BacklogCard({ backlog }: { backlog: HomeBacklog | null }) {
  return (
    <VitalCard
      title="Fila em aberto"
      action={{ href: "/chamados", label: "Ver lista" }}
      loading={backlog === null}
      footer={backlog ? <Flow backlog={backlog} /> : null}
    >
      {backlog ? <BacklogBody backlog={backlog} /> : null}
    </VitalCard>
  );
}

function BacklogBody({ backlog: b }: { backlog: HomeBacklog }) {
  if (b.open === 0) return <p className="text-sm text-ink-muted">Nenhuma OS em aberto</p>;
  // Faixas na ordem natural (da mais nova para a mais antiga), não por tamanho.
  const ages = b.ages.map((a) => ({ id: a.key, name: AGE_LABEL[a.key] ?? a.key, count: a.count }));
  const hrefOf = (item: RankItem) => {
    const age = b.ages.find((a) => a.key === item.id);
    return age && age.count > 0 ? ticketsListHref(age.filters) : undefined;
  };
  return (
    <>
      <div>
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <CountUp value={b.open} tabular={false} className="text-[28px] leading-none font-semibold tracking-[-0.02em] text-ink" />
          <span className="text-sm text-ink-muted">OS em aberto</span>
        </p>
        {b.median_age_days !== null ? (
          <p className="mt-1 text-xs text-ink-muted tabular-nums" title="Idade mediana das OS em aberto, contada da abertura">
            {medianText(b.median_age_days)}
          </p>
        ) : null}
      </div>
      <RankBars items={ages} empty="Nenhuma OS em aberto" href={hrefOf} label="Idade das OS em aberto" />
      <p className="text-xs text-ink-muted tabular-nums">
        {plural(b.recent, "aberta nos últimos 30 dias", "abertas nos últimos 30 dias")}
        {b.old > 0 ? (
          <>
            {" · "}
            <a
              href={`#${OLD_BACKLOG_ID}`}
              className={mutedLink}
              onClick={(e) => {
                if (revealOldBacklog()) e.preventDefault();
              }}
            >
              {intFmt(b.old)} antes disso
            </a>
          </>
        ) : null}
      </p>
    </>
  );
}

/** Rodapé: entradas e saídas de 30 dias e o saldo (só diz "crescendo" com base e acima da folga). */
function Flow({ backlog: b }: { backlog: HomeBacklog }) {
  const net = b.entered_30d - b.resolved_30d - b.cancelled_30d;
  const limit = growthLimit(b.entered_30d);
  let balance: React.ReactNode;
  if (b.entered_30d < MIN_BASE) {
    balance = <span title={BALANCE_HINT}>Saldo {signed(net)}</span>;
  } else if (net > limit) {
    balance = (
      <ProblemText tone="warning" icon={ArrowUpRight} title={BALANCE_HINT}>
        Fila crescendo {signed(net)}
      </ProblemText>
    );
  } else if (net < -limit) {
    balance = (
      <span className="inline-flex items-center gap-1" title={BALANCE_HINT}>
        <ArrowDownRight aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />
        Fila diminuindo {signed(net)}
      </span>
    );
  } else {
    balance = <span title={BALANCE_HINT}>Estável ({signed(net)})</span>;
  }
  return (
    <div className="flex flex-col gap-1 tabular-nums">
      <p>
        Últimos 30 dias: {plural(b.entered_30d, "entrou", "entraram")} · {plural(b.resolved_30d, "resolvida", "resolvidas")} ·{" "}
        {plural(b.cancelled_30d, "cancelada", "canceladas")}
      </p>
      <p>{balance}</p>
    </div>
  );
}
