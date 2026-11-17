"use client";

import { Legend, TrendChart, type TrendSeries } from "@/components/charts";
import { Card, CardHeader, Skeleton, Table, Td, Th } from "@/components/ui";
import type { WeekDay } from "./types";

// "2026-11-17" é dia de calendário: lido em UTC para não virar o dia anterior no fuso do Brasil.
const weekdayFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" });
const dayNumFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", day: "2-digit" });

function utcDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
}

/** "ter., 17/11" (tooltip e tabela). */
const longLabel = (day: string) => {
  const d = utcDay(day);
  return d ? weekdayFmt.format(d) : day;
};
/** "17" (eixo). */
const shortLabel = (day: string) => {
  const d = utcDay(day);
  return d ? dayNumFmt.format(d) : day;
};

const intFmt = (n: number) => n.toLocaleString("pt-BR");

/**
 * Entraram x resolvidas nos últimos 7 dias: duas linhas finas num eixo só, legenda, tooltip na cruz
 * (mouse, toque e setas do teclado) e a tabela com os mesmos números.
 */
export function WeekCard({ week, today }: { week: WeekDay[] | null; today: string }) {
  const days = week ?? [];
  const series: TrendSeries[] = [
    { key: "created", label: "Entraram", color: "var(--viz-1)", values: days.map((d) => d.created) },
    { key: "resolved", label: "Resolvidas", color: "var(--viz-2)", values: days.map((d) => d.resolved) },
  ];
  const created = days.reduce((sum, d) => sum + d.created, 0);
  const resolved = days.reduce((sum, d) => sum + d.resolved, 0);
  // O último dia é hoje, ainda em andamento: o trecho final sai tracejado.
  const partial = days.length > 0 && days[days.length - 1].day === today;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Últimos 7 dias"
        description={week === null ? "Carregando..." : `${intFmt(created)} entraram · ${intFmt(resolved)} resolvidas`}
      />
      {week === null ? (
        <div className="px-5 py-4" role="status" aria-label="Carregando o gráfico">
          <Skeleton className="h-[180px] rounded-lg" />
        </div>
      ) : (
        <>
          <div className="px-5 pt-3">
            <Legend series={series} />
          </div>
          <div className="px-3 pt-1 pb-2">
            <TrendChart
              labels={days.map((d) => shortLabel(d.day))}
              series={series}
              height={190}
              formatLabel={(i) => longLabel(days[i].day)}
              partialLast={partial}
            />
          </div>
          {days.length ? (
            <details className="group border-t border-line">
              <summary className="cursor-pointer px-5 py-2.5 text-xs font-semibold text-ink-muted select-none hover:text-ink">
                Ver em tabela
              </summary>
              <Table label="Entraram e resolvidas por dia">
                <thead>
                  <tr>
                    <Th>Dia</Th>
                    <Th numeric>Entraram</Th>
                    <Th numeric>Resolvidas</Th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.day}>
                      <Td className="py-2">
                        {longLabel(d.day)}
                        {d.day === today ? <span className="text-ink-muted"> · até agora</span> : null}
                      </Td>
                      <Td numeric className="py-2">
                        {intFmt(d.created)}
                      </Td>
                      <Td numeric className="py-2">
                        {intFmt(d.resolved)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </details>
          ) : null}
        </>
      )}
    </Card>
  );
}
