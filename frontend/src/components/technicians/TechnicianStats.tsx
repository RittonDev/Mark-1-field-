"use client";

import { useQuery } from "@tanstack/react-query";
import { Legend, type TrendSeries, TrendChart } from "@/components/charts";
import { ErrorBox, SectionTitle, Skeleton, Table, Td, Th } from "@/components/ui";
import { api } from "@/lib/api";
import { monthAbbr, monthTitle } from "@/lib/constants";
import { useCan } from "@/lib/permissions";
import { technicianStatsKey } from "@/lib/realtime";
import type { TechnicianStats, UUID } from "@/lib/types";

const intFmt = (n: number) => n.toLocaleString("pt-BR");

/**
 * "Atendimentos por mês" na ficha do técnico (aba Elo): os 12 meses de calendário, do mais antigo ao atual, pelo mês da
 * conclusão, separando os deste sistema (Maxx Field) dos que vieram do Field Control. Só contagens (nenhuma OS), com o
 * mesmo critério do elo: responsável ou junto. As ocorrências (atrasos, retornos, perdidas) ficam no Elo, logo acima.
 */
export function TechnicianStatsSection({ technicianId }: { technicianId: UUID }) {
  const canView = useCan("base.technicians");
  const stats = useQuery({
    queryKey: technicianStatsKey(technicianId),
    queryFn: ({ signal }) => api.get<TechnicianStats>(`/technicians/${technicianId}/stats`, undefined, { signal }),
    enabled: canView,
    staleTime: 60_000,
  });
  if (!canView) return null;
  const data = stats.data;
  const months = data?.months ?? [];
  const lastYear = months.reduce((sum, m) => sum + m.services, 0);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <SectionTitle
        wrap
        aside={
          data ? (
            <span className="text-xs text-ink-muted tabular-nums">
              {intFmt(lastYear)} nos últimos 12 meses · {intFmt(data.lifetime.services)} no total
            </span>
          ) : undefined
        }
      >
        Atendimentos por mês
      </SectionTitle>
      {!data ? (
        stats.isError ? (
          <ErrorBox message="Não foi possível carregar os atendimentos por mês." onRetry={() => void stats.refetch()} />
        ) : (
          <Skeleton className="h-[180px]" />
        )
      ) : lastYear === 0 ? (
        <p className="py-8 text-center text-sm text-ink-muted">Sem atendimentos nos últimos 12 meses.</p>
      ) : (
        <MonthsChart data={data} />
      )}
    </section>
  );
}

function MonthsChart({ data }: { data: TechnicianStats }) {
  const months = data.months;
  // Sem nada do Field Control nos 12 meses: uma série só, sem legenda.
  const hasLegacy = months.some((m) => m.legacy > 0);
  const series: TrendSeries[] = [
    { key: "native", label: "Maxx Field", color: "var(--viz-1)", values: months.map((m) => m.services - m.legacy) },
    ...(hasLegacy
      ? [{ key: "legacy", label: "Field Control", color: "var(--viz-2)", values: months.map((m) => m.legacy) }]
      : []),
  ];
  // O mês atual ainda está em andamento: o trecho final sai tracejado.
  const partial = months.length > 0 && months[months.length - 1].current;
  return (
    <>
      {hasLegacy ? <Legend series={series} /> : null}
      <TrendChart
        labels={months.map((m) => monthAbbr(m.month))}
        series={series}
        height={180}
        formatLabel={(i) => monthTitle(months[i].month)}
        partialLast={partial}
        unit="mês"
        partialNote="Trecho tracejado: mês atual, ainda em andamento."
      />
      <details className="text-xs">
        <summary className="w-fit cursor-pointer rounded font-semibold text-ink-muted select-none hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none">
          Ver em tabela
        </summary>
        <div className="mt-2 overflow-hidden rounded-lg border border-line [&_tbody_tr:last-child_td]:border-b-0">
          <Table label="Atendimentos por mês">
            <thead>
              <tr>
                <Th>Mês</Th>
                <Th numeric>Maxx Field</Th>
                <Th numeric>Field Control</Th>
                <Th numeric>Total</Th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <Td className="py-2">
                    {monthTitle(m.month)}
                    {m.current ? <span className="text-ink-muted"> · até agora</span> : null}
                  </Td>
                  <Td numeric className="py-2">
                    {intFmt(m.services - m.legacy)}
                  </Td>
                  <Td numeric className="py-2">
                    {intFmt(m.legacy)}
                  </Td>
                  <Td numeric className="py-2">
                    {intFmt(m.services)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </details>
    </>
  );
}
