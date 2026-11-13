"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Download, Moon, Star, Table2 } from "lucide-react";
import { useState } from "react";
import { Legend, RankBars, StatTile, TrendChart } from "@/components/charts";
import { Button, Card, ErrorBox, Input, LoadingBlock, PageHeader, SectionTitle } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { downloadCsv } from "@/lib/download";
import { formatMinutes, formatMoney } from "@/lib/format";

interface CountRef {
  id: string | null;
  name: string;
  count: number;
}
// Prazos de campo (chegada em até 4h nas capitais; até 4h de técnico na loja).
interface FieldNumbers {
  arrivals?: number;
  arrivals_on_time?: number;
  arrival_on_time_pct?: number | null;
  avg_arrival_minutes?: number | null;
  avg_onsite_minutes?: number | null;
}
interface Numbers extends FieldNumbers {
  opened: number;
  resolved: number;
  cancelled: number;
  unproductive: number;
  scheduled_end: number;
  backlog_end: number;
  resolved_in_sla: number;
}
interface Daily extends FieldNumbers {
  date: string;
  closed: boolean;
  numbers: Numbers;
  previous: Numbers;
  top_customer: CountRef | null;
  customers: CountRef[];
  technicians: CountRef[];
  unproductive_reasons: CountRef[];
}
interface Monthly extends Omit<Daily, "date"> {
  month: string;
  days: { date: string; opened: number; resolved: number; cancelled: number; unproductive: number }[];
  expenses_total: number;
  quotes_approved_total: number;
}

const longDate = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${iso}T12:00:00Z`),
  );
const monthName = (ym: string) =>
  new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${ym}-15T12:00:00Z`));

export default function ReportsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"daily" | "monthly">("daily");
  if (user && !canManageTickets(user.role)) return <ErrorBox message="Relatórios são da gestão." />;
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Relatórios" description="Fechamento do dia (fecha à meia-noite) e o consolidado do mês." />
      <div className="mb-5 flex gap-1 border-b border-line" role="tablist">
        {(
          [
            ["daily", "Diário"],
            ["monthly", "Mensal"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={clsx("relative px-3 pt-1 pb-2.5 text-sm", tab === key ? "font-semibold text-ink" : "font-medium text-ink-muted hover:text-ink")}
          >
            {label}
            {tab === key ? <span className="brand-gradient absolute inset-x-2 -bottom-px h-0.5 rounded-full" /> : null}
          </button>
        ))}
      </div>
      {tab === "daily" ? <DailyView /> : <MonthlyView />}
    </div>
  );
}

function Tiles({ n, prev, prevLabel }: { n: Numbers; prev: Numbers; prevLabel: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <StatTile label="Chamados que entraram" value={n.opened} previous={prev.opened} previousLabel={prevLabel} />
      <StatTile label="Resolvidos" value={n.resolved} previous={prev.resolved} previousLabel={prevLabel} />
      <StatTile label="Cancelados" value={n.cancelled} previous={prev.cancelled} previousLabel={prevLabel} />
      <StatTile label="Improdutivos" value={n.unproductive} previous={prev.unproductive} previousLabel={prevLabel} />
      <StatTile label="Ficaram agendados" value={n.scheduled_end} previous={prev.scheduled_end} previousLabel={prevLabel} />
      <StatTile
        label="Em aberto no fechamento"
        value={n.backlog_end}
        hint={n.resolved ? `${Math.round((n.resolved_in_sla / n.resolved) * 100)}% resolvidos no prazo` : undefined}
      />
    </div>
  );
}

/** Chegada no prazo e tempo na loja: a promessa do chamado, medida no período. */
function FieldTiles({ n, data }: { n: Numbers; data: FieldNumbers }) {
  const arrivals = n.arrivals ?? data.arrivals;
  if (arrivals === undefined) return null;
  const onTime = n.arrivals_on_time ?? data.arrivals_on_time ?? 0;
  const pct = n.arrival_on_time_pct ?? data.arrival_on_time_pct ?? (arrivals ? (onTime / arrivals) * 100 : null);
  const avgArrival = n.avg_arrival_minutes ?? data.avg_arrival_minutes ?? null;
  const avgOnsite = n.avg_onsite_minutes ?? data.avg_onsite_minutes ?? null;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <StatTile
        label="Chegada no prazo"
        value={pct ?? 0}
        display={pct === null ? "—" : `${Math.round(pct)}%`}
        hint={arrivals ? `${onTime} de ${arrivals} chegada(s) dentro do prazo` : "Nenhuma chegada no período"}
      />
      <StatTile
        label="Tempo médio até chegar"
        value={avgArrival ?? 0}
        display={avgArrival === null ? "—" : formatMinutes(Math.round(avgArrival))}
        hint="Da solicitação à chegada"
      />
      <StatTile
        label="Tempo médio na loja"
        value={avgOnsite ?? 0}
        display={avgOnsite === null ? "—" : formatMinutes(Math.round(avgOnsite))}
        hint="Por visita, contado da chegada"
      />
    </div>
  );
}

function Panels({ data, period }: { data: Daily | Monthly; period: string }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="p-4">
        <SectionTitle as="h2" wrap className="mb-3">
          Clientes com mais chamados {period}
        </SectionTitle>
        <RankBars items={data.customers} empty="Nenhum chamado aberto." />
      </Card>
      <Card className="p-4">
        <SectionTitle as="h2" wrap className="mb-3">
          OS resolvidas por técnico
        </SectionTitle>
        <RankBars items={data.technicians} empty="Nenhuma OS resolvida." />
      </Card>
      <Card className="p-4">
        <SectionTitle as="h2" wrap className="mb-3">
          Motivos das visitas improdutivas
        </SectionTitle>
        <RankBars items={data.unproductive_reasons} empty="Nenhuma visita improdutiva." />
      </Card>
    </div>
  );
}

function TopCustomer({ top, period }: { top: CountRef | null; period: string }) {
  if (!top) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <span className="flex size-9 items-center justify-center rounded-full bg-nav-active text-brand">
        <Star className="size-4" />
      </span>
      <div>
        <p className="text-xs font-semibold text-ink/80">Cliente destaque {period}</p>
        <p className="text-sm text-ink">
          <strong className="font-semibold">{top.name}</strong> · {top.count} chamado{top.count > 1 ? "s" : ""}
        </p>
      </div>
    </div>
  );
}

function DailyView() {
  const [date, setDate] = useState<string | null>(null);
  const report = useQuery({
    queryKey: ["reports", "daily", date ?? "default"],
    queryFn: () => api.get<Daily>("/reports/daily", { date: date ?? undefined }),
    placeholderData: (previous) => previous,
  });
  const data = report.data;
  if (report.isLoading) return <LoadingBlock />;
  if (!data) return <ErrorBox message={errorMessage(report.error)} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink first-letter:uppercase">{longDate(data.date)}</h2>
          <p className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
            <Moon className="size-3.5" />
            {data.closed ? "Dia fechado à meia-noite" : "Hoje: parcial, fecha à meia-noite"}
          </p>
        </div>
        <div className="w-44">
          <Input type="date" value={data.date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Dia" />
        </div>
      </div>
      <Tiles n={data.numbers} prev={data.previous} prevLabel="vs dia anterior" />
      <FieldTiles n={data.numbers} data={data} />
      <TopCustomer top={data.top_customer} period="do dia" />
      <Panels data={data} period="no dia" />
    </div>
  );
}

function MonthlyView() {
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  const [table, setTable] = useState(false);
  const report = useQuery({
    queryKey: ["reports", "monthly", month],
    queryFn: () => api.get<Monthly>("/reports/monthly", { month }),
    placeholderData: (previous) => previous,
  });
  const data = report.data;
  if (report.isLoading) return <LoadingBlock />;
  if (!data) return <ErrorBox message={errorMessage(report.error)} />;
  const labels = data.days.map((d) => d.date.slice(8, 10));
  const series = [
    { key: "opened", label: "Entraram", color: "var(--viz-1)", values: data.days.map((d) => d.opened) },
    { key: "resolved", label: "Resolvidos", color: "var(--viz-2)", values: data.days.map((d) => d.resolved) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink first-letter:uppercase">{monthName(data.month)}</h2>
          <p className="text-xs text-ink-muted">{data.closed ? "Mês fechado" : "Mês em andamento (até hoje)"}</p>
        </div>
        <div className="flex gap-2">
          <div className="w-44">
            <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Mês" />
          </div>
          <Button
            onClick={() =>
              downloadCsv(`relatorio-${data.month}.csv`, [
                ["dia", "entraram", "resolvidos", "cancelados", "improdutivos"],
                ...data.days.map((d) => [d.date, d.opened, d.resolved, d.cancelled, d.unproductive]),
              ])
            }
          >
            <Download className="size-4" />
            CSV
          </Button>
        </div>
      </div>
      <Tiles n={data.numbers} prev={data.previous} prevLabel="vs mês anterior" />
      <FieldTiles n={data.numbers} data={data} />
      <div className="grid gap-3 sm:grid-cols-3">
        <TopCustomer top={data.top_customer} period="do mês" />
        <StatTile label="Custos extras no mês" value={data.expenses_total} display={formatMoney(data.expenses_total)} />
        <StatTile label="Orçamentos aprovados" value={data.quotes_approved_total} display={formatMoney(data.quotes_approved_total)} />
      </div>
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <SectionTitle as="h2">Chamados por dia</SectionTitle>
            <Legend series={series} />
          </div>
          <Button size="sm" variant="ghost" onClick={() => setTable((v) => !v)}>
            <Table2 className="size-4" />
            {table ? "Ver gráfico" : "Ver tabela"}
          </Button>
        </div>
        {table ? (
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-sm tabular-nums">
              <thead className="sticky top-0 bg-surface text-left text-xs text-ink-muted">
                <tr>
                  <th className="py-1.5 font-semibold">Dia</th>
                  <th className="py-1.5 text-right font-semibold">Entraram</th>
                  <th className="py-1.5 text-right font-semibold">Resolvidos</th>
                  <th className="py-1.5 text-right font-semibold">Cancelados</th>
                  <th className="py-1.5 text-right font-semibold">Improdutivos</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.days.map((d) => (
                  <tr key={d.date}>
                    <td className="py-1.5 text-ink">{d.date.split("-").reverse().join("/")}</td>
                    <td className="py-1.5 text-right">{d.opened}</td>
                    <td className="py-1.5 text-right">{d.resolved}</td>
                    <td className="py-1.5 text-right">{d.cancelled}</td>
                    <td className="py-1.5 text-right">{d.unproductive}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <TrendChart labels={labels} series={series} />
        )}
      </Card>
      <Panels data={data} period="no mês" />
    </div>
  );
}
