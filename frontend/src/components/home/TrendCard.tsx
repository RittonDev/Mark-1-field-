"use client";

import { useState } from "react";
import { Legend, TrendChart, type TrendSeries } from "@/components/charts";
import { Tabs } from "@/components/motion";
import { Card, CardHeader, Skeleton, Table, Td, Th } from "@/components/ui";
import { dayMonth, intFmt, plural, shiftDay } from "./rules";
import type { WeekDay, WeekFlow } from "./types";

// "2026-11-17" é dia de calendário: lido em UTC para não virar o dia anterior no fuso do Brasil.
const weekdayFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" });
const dayNumFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", day: "2-digit" });

function utcDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
}

type View = "weeks" | "days";

/** Um ponto do gráfico (semana ou dia) e a linha da tabela. */
interface Point {
  key: string;
  /** Rótulo do eixo ("09/11" ou "17"). */
  axis: string;
  /** Tooltip e tabela ("Semana de 09/11" ou "ter., 17/11"). */
  title: string;
  created: number;
  resolved: number;
  /** Ainda em andamento (a semana ou o dia de hoje). */
  current: boolean;
}

function weekPoints(weeks: WeekFlow[], today: string): Point[] {
  return weeks.map((w) => ({
    key: w.start,
    axis: dayMonth(w.start),
    title: `Semana de ${dayMonth(w.start)}`,
    created: w.created,
    resolved: w.resolved,
    current: w.start <= today && today < shiftDay(w.start, 7),
  }));
}

function dayPoints(days: WeekDay[], today: string): Point[] {
  return days.map((d) => {
    const date = utcDay(d.day);
    return {
      key: d.day,
      axis: date ? dayNumFmt.format(date) : d.day,
      title: date ? weekdayFmt.format(date) : d.day,
      created: d.created,
      resolved: d.resolved,
      current: d.day === today,
    };
  });
}

/**
 * Entraram x resolvidas: 8 semanas (padrão) ou os últimos 7 dias. Duas linhas finas num eixo só,
 * legenda, tooltip na cruz (mouse, toque e setas do teclado) e a tabela com os mesmos números. A API
 * antiga não manda as semanas: aí fica só a vista de 7 dias, sem abas.
 */
export function TrendCard({ week, weeks, today }: { week: WeekDay[] | null; weeks: WeekFlow[] | null; today: string }) {
  const [view, setView] = useState<View>("weeks");
  const hasWeeks = weeks !== null && weeks.length > 0;
  const shown: View = hasWeeks ? view : "days";
  const points = week === null ? null : shown === "weeks" && weeks ? weekPoints(weeks, today) : dayPoints(week, today);
  const created = points?.reduce((sum, p) => sum + p.created, 0) ?? 0;
  const resolved = points?.reduce((sum, p) => sum + p.resolved, 0) ?? 0;
  // A soma da vista que está na tela.
  const total = `${plural(created, "entrou", "entraram")} · ${plural(resolved, "resolvida", "resolvidas")}`;
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Tendência" description={points === null ? "Carregando..." : total} />
      {points === null ? (
        <div className="px-5 py-4" role="status" aria-label="Carregando o gráfico">
          <Skeleton className="h-[180px]" />
        </div>
      ) : (
        <>
          {hasWeeks ? (
            <div className="px-5 pt-3">
              <Tabs<View>
                variant="segmented"
                className="w-fit"
                items={[
                  { key: "weeks", label: `${weeks.length} semanas` },
                  { key: "days", label: "7 dias" },
                ]}
                value={view}
                onChange={setView}
                ariaLabel="Período do gráfico"
                idPrefix="tendencia"
              />
            </div>
          ) : null}
          <div
            role={hasWeeks ? "tabpanel" : undefined}
            id={hasWeeks ? `tendencia-panel-${shown}` : undefined}
            aria-labelledby={hasWeeks ? `tendencia-tab-${shown}` : undefined}
          >
            <FlowChart points={points} weekly={shown === "weeks"} />
          </div>
        </>
      )}
    </Card>
  );
}

function FlowChart({ points, weekly }: { points: Point[]; weekly: boolean }) {
  const series: TrendSeries[] = [
    { key: "created", label: "Entraram", color: "var(--viz-1)", values: points.map((p) => p.created) },
    { key: "resolved", label: "Resolvidas", color: "var(--viz-2)", values: points.map((p) => p.resolved) },
  ];
  // O último ponto ainda está em andamento: o trecho final sai tracejado.
  const partial = points.length > 0 && points[points.length - 1].current;
  return (
    <>
      <div className="px-5 pt-3">
        <Legend series={series} />
      </div>
      <div className="px-3 pt-1 pb-2">
        <TrendChart
          labels={points.map((p) => p.axis)}
          series={series}
          height={190}
          formatLabel={(i) => points[i].title}
          partialLast={partial}
          unit={weekly ? "semana" : "dia"}
          partialNote={weekly ? "Trecho tracejado: semana atual, ainda em andamento." : undefined}
        />
      </div>
      {points.length ? (
        <details className="group border-t border-line">
          <summary className="cursor-pointer px-5 py-2.5 text-xs font-semibold text-ink-muted select-none hover:text-ink">
            Ver em tabela
          </summary>
          <Table label={weekly ? "Entraram e resolvidas por semana" : "Entraram e resolvidas por dia"}>
            <thead>
              <tr>
                <Th>{weekly ? "Semana" : "Dia"}</Th>
                <Th numeric>Entraram</Th>
                <Th numeric>Resolvidas</Th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.key}>
                  <Td className="py-2">
                    {p.title}
                    {p.current ? <span className="text-ink-muted"> · até agora</span> : null}
                  </Td>
                  <Td numeric className="py-2">
                    {intFmt(p.created)}
                  </Td>
                  <Td numeric className="py-2">
                    {intFmt(p.resolved)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </details>
      ) : null}
    </>
  );
}
