"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { CountUp } from "@/components/motion";
import { mutedLink, ProblemText } from "../figures";
import { ticketsListHref } from "../links";
import { OLD_BACKLOG_ID, revealOldBacklog } from "../OldBacklog";
import { AGE_LABEL, growthLimit, intFmt, MIN_BASE, plural, signed } from "../rules";
import type { HomeBacklog } from "../types";
import { VitalCard } from "./VitalCard";

const BALANCE_HINT = "Entraram − resolvidas − canceladas nos últimos 30 dias";
const AGES_LABEL = "Idade das OS em aberto";

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
      <AgeRows backlog={b} />
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

/**
 * Idade da fila numa linha por faixa (nome, barra e número), na ordem natural (da mais nova para a mais
 * antiga), não por tamanho: cabe na primeira dobra junto dos outros sinais vitais.
 */
function AgeRows({ backlog: b }: { backlog: HomeBacklog }) {
  const max = Math.max(...b.ages.map((a) => a.count), 1);
  return (
    <ol className="flex flex-col gap-2" aria-label={AGES_LABEL}>
      {b.ages.map((a) => {
        const label = AGE_LABEL[a.key] ?? a.key;
        const name = `${label}: ${plural(a.count, "OS", "OS")}`;
        return (
          <li key={a.key} className="grid grid-cols-[6.75rem_minmax(0,1fr)_2.75rem] items-center gap-2 text-xs">
            {a.count > 0 ? (
              <Link
                href={ticketsListHref(a.filters)}
                className="truncate font-semibold text-ink hover:text-brand hover:underline"
                aria-label={name}
              >
                {label}
              </Link>
            ) : (
              <span className="truncate font-semibold text-ink">{label}</span>
            )}
            <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <span className="grow-x block h-full rounded-full" style={{ width: `${(a.count / max) * 100}%`, background: "var(--viz-1)" }} />
            </span>
            <span className="text-right font-medium text-ink tabular-nums">{intFmt(a.count)}</span>
          </li>
        );
      })}
    </ol>
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
      <p title={`${plural(b.resolved_30d, "resolvida", "resolvidas")} e ${plural(b.cancelled_30d, "cancelada", "canceladas")}`}>
        30 dias: {plural(b.entered_30d, "entrou", "entraram")} · {plural(b.resolved_30d + b.cancelled_30d, "saiu", "saíram")}
      </p>
      <p>{balance}</p>
    </div>
  );
}
