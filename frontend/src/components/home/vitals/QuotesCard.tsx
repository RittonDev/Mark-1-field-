"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { CountUp } from "@/components/motion";
import { formatMoney } from "@/lib/format";
import { ProblemText } from "../figures";
import { intFmt, MIN_BASE, pctText, plural, share } from "../rules";
import type { HomeQuotes } from "../types";
import { VitalCard } from "./VitalCard";

// Cada número abre a lista de Orçamentos que o mostra (a lista lê a situação e o período do endereço).
/** Os que aguardam a assinatura, de qualquer data. */
const AWAITING_HREF = "/orcamentos?situacao=sent&periodo=tudo";
const FOLLOW_UP_HREF = "/orcamentos?cobrar=1";
/** Os últimos 90 dias são o período padrão da lista. */
const EXPIRED_HREF = "/orcamentos?situacao=expired";
const DRAFTS_HREF = "/orcamentos?situacao=draft&periodo=tudo";

const AWAITING_HINT = "Enviados ao cliente e ainda na validade (ou sem validade)";
const NO_LINK_HINT = "Aguardando sem link: o cliente não tem como abrir nem assinar";
const EXPIRING_HINT = "Aguardando com a validade terminando hoje ou amanhã";
const FOLLOW_UP_HINT = "Sem resposta há 2 dias, vencendo, em revisão parada ou vencidos na última semana";
const EXPIRED_HINT = "Criados nos últimos 90 dias e vencidos sem resposta";
const DRAFTS_HINT = "Ainda não enviados; em revisão: editados depois do envio, esperando reenviar";
const MONTH_HINT = "Respondidos pelo cliente neste mês, sem OS cancelada";
const RATE_HINT = "Aprovados sobre aprovados, recusados e vencidos dos últimos 90 dias, sem OS cancelada";

const valueLink = "underline-offset-2 hover:text-brand-ink hover:underline";

/**
 * Sinal vital 4: os orçamentos esperando o cliente (e os que ele não tem como assinar), a fila de
 * cobrança, o dinheiro que venceu e o que o mês aprovou. Sem orçamento, nada de "R$ 0,00": quem decide o
 * que aparece são as contagens.
 */
export function QuotesCard({ quotes }: { quotes: HomeQuotes | null }) {
  return (
    <VitalCard
      title="Orçamentos"
      action={{ href: "/orcamentos", label: "Ver orçamentos" }}
      loading={quotes === null}
      footer={quotes ? <Decided quotes={quotes} /> : null}
    >
      {quotes ? <QuotesBody quotes={quotes} /> : null}
    </VitalCard>
  );
}

function QuotesBody({ quotes: q }: { quotes: HomeQuotes }) {
  return (
    <>
      <div>
        {q.awaiting > 0 ? (
          <Link href={AWAITING_HREF} className="group block w-fit max-w-full rounded-sm" title={AWAITING_HINT}>
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <CountUp value={q.awaiting} tabular={false} className="text-[28px] leading-none font-semibold tracking-[-0.02em] text-ink" />
              <span className="text-sm text-ink-muted underline-offset-2 group-hover:text-ink group-hover:underline">
                aguardando assinatura
              </span>
            </span>
            <span className="mt-1 block text-sm font-medium text-ink tabular-nums">{formatMoney(q.awaiting_total)}</span>
          </Link>
        ) : (
          <p className="text-sm text-ink-muted" title={AWAITING_HINT}>
            Nenhum aguardando assinatura
          </p>
        )}
        {q.awaiting_no_link > 0 || q.expiring > 0 ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
            {/* Os sem link abrem a lista dos que aguardam: todos estão lá, cada um com o "Gerar o link" (na
                fila "Para cobrar", o enviado há mais de 30 dias só entra perto de vencer). */}
            {q.awaiting_no_link > 0 ? (
              <ProblemText tone="warning" icon={TriangleAlert} href={AWAITING_HREF} title={NO_LINK_HINT}>
                {intFmt(q.awaiting_no_link)} sem link
              </ProblemText>
            ) : null}
            {q.expiring > 0 ? (
              <ProblemText tone="warning" icon={TriangleAlert} href={AWAITING_HREF} title={EXPIRING_HINT}>
                {plural(q.expiring, "vence até amanhã", "vencem até amanhã")}
              </ProblemText>
            ) : null}
          </p>
        ) : null}
      </div>

      <dl className="flex flex-col gap-2 text-[13px]">
        <Row
          label="Para cobrar"
          title={FOLLOW_UP_HINT}
          href={FOLLOW_UP_HREF}
          value={q.follow_up > 0 ? `${intFmt(q.follow_up)} · ${formatMoney(q.follow_up_total)}` : null}
          empty="Nada para cobrar"
        />
        {/* Vencido é dinheiro perdido: âmbar quando há. */}
        <Row
          label="Vencidos (90 dias)"
          title={EXPIRED_HINT}
          href={EXPIRED_HREF}
          value={q.expired_90d > 0 ? `${intFmt(q.expired_90d)} · ${formatMoney(q.expired_90d_total)}` : null}
          empty="Nenhum"
          problem
        />
        <Row
          label="Rascunhos"
          title={DRAFTS_HINT}
          href={DRAFTS_HREF}
          value={q.drafts > 0 ? `${intFmt(q.drafts)}${q.in_review > 0 ? ` · ${intFmt(q.in_review)} em revisão` : ""}` : null}
          empty="Nenhum"
        />
      </dl>
    </>
  );
}

/**
 * Uma linha: o nome (com a definição no title) à esquerda e o número à direita, com link para a lista que
 * o mostra. Sem nada (value null), o texto neutro de `empty`.
 */
function Row({
  label,
  title,
  href,
  value,
  empty,
  problem,
}: {
  label: string;
  title: string;
  href: string;
  value: string | null;
  empty: string;
  problem?: boolean;
}) {
  // O nome vai junto no link (só para o leitor de tela): na relação de links, "8 · R$ 900,00" sozinho não diz o quê.
  const text = (
    <>
      <span className="sr-only">{label}: </span>
      {value}
    </>
  );
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <dt className="text-ink-muted" title={title}>
        {label}
      </dt>
      <dd className="ml-auto text-right font-medium text-ink tabular-nums">
        {value === null ? (
          <span className="font-normal text-ink-muted">{empty}</span>
        ) : problem ? (
          <ProblemText tone="warning" icon={TriangleAlert} href={href}>
            {text}
          </ProblemText>
        ) : (
          <Link href={href} className={valueLink}>
            {text}
          </Link>
        )}
      </dd>
    </div>
  );
}

/** Rodapé: o que o cliente respondeu no mês e a taxa de aprovação de 90 dias (com base pequena, só "N de M"). */
function Decided({ quotes: q }: { quotes: HomeQuotes }) {
  const rate = share({ count: q.approved_90d, base: q.decided_90d }, MIN_BASE);
  const month = [
    q.approved_month > 0
      ? `Aprovados no mês: ${intFmt(q.approved_month)} · ${formatMoney(q.approved_month_total)}`
      : "Nenhum aprovado no mês",
    ...(q.rejected_month > 0 ? [plural(q.rejected_month, "recusado", "recusados")] : []),
  ].join(" · ");
  return (
    <div className="flex flex-col gap-1 tabular-nums">
      <p title={MONTH_HINT}>{month}</p>
      {q.decided_90d > 0 ? (
        <p title={RATE_HINT}>Aprovação em 90 dias: {rate.pct !== null ? `${pctText(rate.pct)} (${rate.text})` : rate.text}</p>
      ) : null}
    </div>
  );
}
