"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { formatMoney } from "@/lib/format";
import { mutedLink, ProblemText } from "../figures";
import { ticketsListHref } from "../links";
import { intFmt, plural } from "../rules";
import type { HomeFinance } from "../types";
import { VitalCard } from "./VitalCard";

const rowTitle = "text-xs font-semibold text-ink-muted";
const valueLink = "underline-offset-2 hover:text-brand-ink hover:underline";

/**
 * Sinal vital 4: o que se deve aos técnicos e o dinheiro parado em orçamentos e custos. Tabela vazia
 * nunca vira "R$ 0,00": quem decide o que aparece são as contagens, não os valores.
 */
export function FinanceCard({ finance }: { finance: HomeFinance | null }) {
  return (
    <VitalCard title="Financeiro" action={{ href: "/pagamentos", label: "Pagamentos" }} loading={finance === null}>
      {finance ? <FinanceBody finance={finance} /> : null}
    </VitalCard>
  );
}

function FinanceBody({ finance: f }: { finance: HomeFinance }) {
  const tagText = f.payout_tag
    ? [
        `${plural(f.payout_tag_tickets, "OS concluída", "OS concluídas")} com “${f.payout_tag}”`,
        plural(f.payout_tag_technicians, "técnico", "técnicos"),
        ...(f.payout_tag_over_30d > 0 ? [`${intFmt(f.payout_tag_over_30d)} há mais de 30 dias`] : []),
      ].join(" · ")
    : "";
  return (
    <>
      <div>
        <h3 className={rowTitle}>A pagar aos técnicos</h3>
        {f.payouts_to_pay_count > 0 ? (
          <>
            <p className="mt-0.5 text-xl font-semibold tracking-[-0.01em] text-ink">{formatMoney(f.payouts_to_pay)}</p>
            <p className="text-xs text-ink-muted tabular-nums">
              {plural(f.payouts_to_pay_count, "pagamento", "pagamentos")} · {plural(f.payouts_technicians, "técnico", "técnicos")}
            </p>
            {f.payouts_late > 0 ? (
              <p className="mt-0.5 text-xs tabular-nums">
                <ProblemText tone="warning" icon={TriangleAlert} href="/pagamentos">
                  {plural(f.payouts_late, "concluída há mais de 7 dias", "concluídas há mais de 7 dias")}
                </ProblemText>
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-0.5 text-sm text-ink-muted">Sem valores lançados</p>
        )}
        {f.payouts_expected > 0 ? (
          <p className="mt-0.5 text-xs text-ink-muted tabular-nums">{formatMoney(f.payouts_expected)} previstos em OS em aberto</p>
        ) : null}
        {f.payout_tag && f.payout_tag_tickets > 0 ? (
          <p className="mt-1 text-xs text-ink-muted tabular-nums">
            {f.payout_tag_filters ? (
              <Link href={ticketsListHref(f.payout_tag_filters)} className={mutedLink}>
                {tagText}
              </Link>
            ) : (
              tagText
            )}
          </p>
        ) : null}
      </div>

      <div>
        <h3 className={rowTitle}>Orçamentos</h3>
        <p className="mt-0.5 text-[13px] text-ink tabular-nums">
          {f.quotes_waiting > 0 ? (
            <Link href="/orcamentos" className={valueLink}>
              {intFmt(f.quotes_waiting)} aguardando resposta · {formatMoney(f.quotes_waiting_total)}
            </Link>
          ) : (
            <span className="text-ink-muted">Nenhum aguardando resposta</span>
          )}
        </p>
        <p className="mt-1.5 text-[13px] text-ink tabular-nums">
          {f.quotes_approved_month > 0 ? (
            <Link href="/orcamentos" className={valueLink}>
              {plural(f.quotes_approved_month, "aprovado no mês", "aprovados no mês")} · {formatMoney(f.quotes_approved_month_total)}
            </Link>
          ) : (
            <span className="text-ink-muted">Nenhum aprovado no mês</span>
          )}
        </p>
      </div>

      <div>
        <h3 className={rowTitle}>Custos extras</h3>
        <p className="mt-0.5 text-[13px] text-ink tabular-nums">
          {f.costs_pending > 0 ? (
            <Link href="/custos" className={valueLink}>
              {intFmt(f.costs_pending)} a aprovar · {formatMoney(f.costs_pending_total)}
            </Link>
          ) : (
            <span className="text-ink-muted">Nenhum a aprovar</span>
          )}
        </p>
      </div>
    </>
  );
}
