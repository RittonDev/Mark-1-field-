"use client";

import Link from "next/link";
import { useCan } from "@/lib/permissions";
import { MeterRow, mutedLink } from "../figures";
import { dayMonth, intFmt, MIN_BASE, pctText, plural, share, shiftDay, SLA_FLOOR, SLA_TARGET } from "../rules";
import type { HomeQuality } from "../types";
import { VitalCard } from "./VitalCard";

/**
 * Sinal vital 3: o que o cliente sente (chegada no horário, prazo cumprido, loja que chama de novo).
 * Os atalhos para Relatórios só aparecem para quem tem acesso a eles.
 */
export function ServiceCard({ quality, windowFrom }: { quality: HomeQuality | null; windowFrom: string | null }) {
  const canReports = useCan("analysis.reports");
  // A janela vai de window_from (hoje − 29) até hoje.
  const period = windowFrom ? `${dayMonth(windowFrom)} a ${dayMonth(shiftDay(windowFrom, 29))}` : undefined;
  return (
    <VitalCard
      title="Atendimento ao cliente"
      description={period}
      action={canReports ? { href: "/relatorios?aba=sla&dias=30", label: "Violações de SLA" } : undefined}
      loading={quality === null}
      footer={quality ? <Unproductive quality={quality} /> : null}
    >
      {quality ? <ServiceBody quality={quality} /> : null}
    </VitalCard>
  );
}

function ServiceBody({ quality: q }: { quality: HomeQuality }) {
  const sla = q.resolution_sla;
  // Enquanto a base for quase toda do Field Control, o prazo é o contratual de lá (não o da Maxx).
  const imported = sla.base > 0 && q.resolution_sla_imported * 2 >= sla.base;
  const days = q.return_days;
  return (
    <>
      <MeterRow
        label="Chegada no horário"
        ratio={q.on_time}
        min={MIN_BASE}
        title="Chegou até o prazo de chegada da OS ou, sem prazo, até 30 min depois do horário agendado."
      />
      <MeterRow
        label="Prazo de solução cumprido"
        ratio={sla}
        min={MIN_BASE}
        target={SLA_TARGET}
        floor={SLA_FLOOR}
        unit="com prazo"
        title="Resolvidas até o prazo de solução, entre as OS que têm prazo."
        note={imported ? `Prazos do Field Control em ${intFmt(q.resolution_sla_imported)} de ${intFmt(sla.base)}` : null}
      />
      <MeterRow
        label={`Loja chamou de novo em ${days} dias`}
        ratio={q.store_return}
        min={MIN_BASE}
        title={`Nova corretiva na mesma loja até ${days} dias depois da conclusão; concluídas entre ${days + 30} e ${days} dias atrás.`}
      />
    </>
  );
}

/** Rodapé: idas à loja perdidas. */
function Unproductive({ quality: q }: { quality: HomeQuality }) {
  const canReports = useCan("analysis.reports");
  const rate = share({ count: q.unproductive, base: q.visits }, MIN_BASE);
  const text =
    q.unproductive === 0
      ? "Nenhuma visita improdutiva"
      : `${plural(q.unproductive, "visita improdutiva", "visitas improdutivas")} · ${
          rate.pct !== null ? `${pctText(rate.pct)} das idas à loja` : `${rate.text} idas à loja`
        }`;
  const title = "Idas à loja: chegadas e improdutivas nos últimos 30 dias";
  if (!canReports) {
    return (
      <span className="tabular-nums" title={title}>
        {text}
      </span>
    );
  }
  return (
    <Link href="/relatorios?aba=mensal" className={`tabular-nums ${mutedLink}`} title={title}>
      {text}
    </Link>
  );
}
