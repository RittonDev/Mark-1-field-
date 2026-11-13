"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, Copy, Download, Moon, Table2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Legend, RankBars, StatTile, TrendChart } from "@/components/charts";
import { Tabs } from "@/components/motion";
import { SlaViolationsCard } from "@/components/SlaViolationsCard";
import { useToast } from "@/components/Toaster";
import { useNow } from "@/components/useNow";
import { Button, Card, ErrorBox, Input, LoadingBlock, PageHeader, SectionTitle, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { downloadCsv } from "@/lib/download";
import { formatDocument, formatMinutes, formatMoney, OPERATION_TZ } from "@/lib/format";
import { useCustomers } from "@/lib/queries";
import type { DailyReport, DayNumbers, MonthlyReport, PayoutList, ReportCountRef, ReportDayPoint, UUID } from "@/lib/types";
import { copyText } from "@/lib/whatsapp";

type Tab = "diario" | "mensal" | "sla";
type Cell = string | number | null | undefined;

/** Recorte por cliente (a prestação de contas dos clientes grandes); sem ele, a operação inteira. */
interface CustomerScope {
  id: UUID;
  name: string;
}

const SLA_DAYS = [7, 30, 90, 180, 365];
/** Meta de prazo: abaixo dela o número fica âmbar; abaixo do piso, vermelho. */
const TARGET = 90;
const FLOOR = 75;
const DAY_RE = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^20\d{2}-(0[1-9]|1[0-2])$/;

const intFmt = (n: number) => n.toLocaleString("pt-BR");
const plural = (n: number, one: string, many: string) => `${intFmt(n)} ${n === 1 ? one : many}`;
const pctFmt = (v: number) => `${Math.round(v).toLocaleString("pt-BR")}%`;
const csvMoney = (v: number) => v.toFixed(2).replace(".", ",");
/** "2026-11-12" -> "12/11/2026". */
const brDate = (iso: string) => iso.split("-").reverse().join("/");
const dayISO = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: OPERATION_TZ }).format(new Date(ms));
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "Lojas Exemplo Ltda." -> "lojas-exemplo-ltda" (para o nome do arquivo). */
const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const fileSuffix = (scope: CustomerScope | null) => (scope ? `-${slug(scope.name) || "cliente"}` : "");

const longDate = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${iso}T12:00:00Z`),
  );
/** "qui., 12/11": o dia no tooltip e na tabela do gráfico. */
const shortDay = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
const monthName = (ym: string) =>
  capitalize(new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${ym}-15T12:00:00Z`)));

/** Data que existe no calendário (o campo de data aceita 31/02 enquanto se digita). */
function isDay(value: string | null): value is string {
  if (!value || !DAY_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
}

function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** Os últimos 24 meses, do atual para trás (e o mês escolhido, se for mais antigo que isso). */
function monthOptions(current: string, chosen: string): string[] {
  const [y, m] = current.split("-").map(Number);
  const list = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(y, m - 1 - i, 15)).toISOString().slice(0, 7));
  return list.includes(chosen) ? list : [...list, chosen];
}

function monthDays(ym: string): { date_from: string; date_to: string } {
  const [y, m] = ym.split("-").map(Number);
  return { date_from: `${ym}-01`, date_to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

/** Aba, dia e mês ficam na URL (sem navegar): recarregar mantém e o link vai para um colega. */
function setParams(patch: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(patch)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  // Mantém a marca da OS aberta no painel lateral (?os=), se houver.
  const state = window.history.state as { mfPanel?: string } | null;
  window.history.replaceState(state?.mfPanel ? { mfPanel: state.mfPanel } : null, "", `${url.pathname}${url.search}${url.hash}`);
}

interface CompareLabels {
  previousLabel: string;
  sameLabel: string;
}

/**
 * Comparação com o período anterior. O que entra e sai no período (fluxo) se compara com o total do
 * anterior; o que fica no fim (agendados, em aberto), com como o anterior terminou. Com o período
 * ainda em andamento, o texto diz que o anterior está inteiro.
 */
function comparison(period: "day" | "month", partial: boolean): { flow: CompareLabels; stock: CompareLabels } {
  if (period === "day") {
    return partial
      ? {
          flow: { previousLabel: "vs total de ontem", sameLabel: "igual ao total de ontem" },
          stock: { previousLabel: "vs fim de ontem", sameLabel: "igual ao fim de ontem" },
        }
      : {
          flow: { previousLabel: "vs dia anterior", sameLabel: "igual ao dia anterior" },
          stock: { previousLabel: "vs dia anterior", sameLabel: "igual ao dia anterior" },
        };
  }
  return partial
    ? {
        flow: { previousLabel: "vs mês anterior inteiro", sameLabel: "igual ao mês anterior inteiro" },
        stock: { previousLabel: "vs fim do mês anterior", sameLabel: "igual ao fim do mês anterior" },
      }
    : {
        flow: { previousLabel: "vs mês anterior", sameLabel: "igual ao mês anterior" },
        stock: { previousLabel: "vs mês anterior", sameLabel: "igual ao mês anterior" },
      };
}

const deltaText = (value: number, previous: number, labels: CompareLabels) =>
  value === previous ? labels.sameLabel : `${value > previous ? "+" : "−"}${intFmt(Math.abs(value - previous))} ${labels.previousLabel}`;

/** Indicadores do período e do anterior, para o CSV (minutos e percentuais sem unidade, para a planilha somar). */
function summaryRows(n: DayNumbers, p: DayNumbers, partial: boolean): Cell[][] {
  const pct = (v: number | null) => (v === null ? "" : v.toFixed(1).replace(".", ","));
  return [
    ["Chamados que entraram", n.opened, p.opened],
    ["Resolvidos", n.resolved, p.resolved],
    ["Cancelados", n.cancelled, p.cancelled],
    ["Visitas improdutivas", n.unproductive, p.unproductive],
    [partial ? "Agendados agora" : "Ficaram agendados", n.scheduled_end, p.scheduled_end],
    [partial ? "Em aberto agora" : "Em aberto no fechamento", n.backlog_end, p.backlog_end],
    ["Resolvidos no prazo", n.resolved_in_sla, p.resolved_in_sla],
    ["Chegadas do técnico", n.arrivals, p.arrivals],
    ["Chegadas no prazo", n.arrivals_on_time, p.arrivals_on_time],
    ["Chegada no prazo (%)", pct(n.arrival_on_time_pct), pct(p.arrival_on_time_pct)],
    ["Tempo médio até chegar (min)", n.avg_arrival_minutes, p.avg_arrival_minutes],
    ["Tempo médio na loja (min)", n.avg_onsite_minutes, p.avg_onsite_minutes],
  ];
}

/** Rankings do período; com o recorte por cliente, o de clientes sai (seria só ele). */
function rankingRows(data: DailyReport | MonthlyReport, scope: CustomerScope | null): Cell[][] {
  const block = (title: string, unit: string, items: ReportCountRef[]): Cell[][] => [[title, unit], ...items.map((i) => [i.name, i.count]), []];
  return [
    ...(scope ? [] : block("Clientes com mais chamados", "Chamados", data.customers)),
    ...block("OS resolvidas por técnico", "OS", data.technicians),
    ...block("Motivos das visitas improdutivas", "Visitas", data.unproductive_reasons),
  ];
}

const scopeRows = (scope: CustomerScope | null): Cell[][] => (scope ? [["Cliente", scope.name]] : []);

function exportDaily(data: DailyReport, partial: boolean, scope: CustomerScope | null) {
  downloadCsv(`fechamento-${data.date}${fileSuffix(scope)}.csv`, [
    ["Fechamento do dia", brDate(data.date)],
    ...scopeRows(scope),
    ["Situação", partial ? "Parcial: o dia fecha à meia-noite" : "Dia fechado à meia-noite"],
    [],
    ["Indicador", brDate(data.date), `${brDate(shiftDay(data.date, -1))}${partial ? " (dia inteiro)" : ""}`],
    ...summaryRows(data.numbers, data.previous, partial),
    [],
    ...rankingRows(data, scope),
  ]);
}

function exportMonthly(data: MonthlyReport, partial: boolean, payouts: PayoutList["summary"] | undefined, scope: CustomerScope | null) {
  const [y, m] = data.month.split("-").map(Number);
  const previous = new Date(Date.UTC(y, m - 2, 15)).toISOString().slice(0, 7);
  const total = data.days.reduce(
    (t, d) => ({ opened: t.opened + d.opened, resolved: t.resolved + d.resolved, cancelled: t.cancelled + d.cancelled, unproductive: t.unproductive + d.unproductive }),
    { opened: 0, resolved: 0, cancelled: 0, unproductive: 0 },
  );
  downloadCsv(`relatorio-${data.month}${fileSuffix(scope)}.csv`, [
    ["Relatório do mês", monthName(data.month)],
    ...scopeRows(scope),
    ["Situação", partial ? "Mês em andamento (até hoje)" : "Mês fechado"],
    [],
    ["Indicador", monthName(data.month), `${monthName(previous)}${partial ? " (mês inteiro)" : ""}`],
    ...summaryRows(data.numbers, data.previous, partial),
    ["Custos extras (R$)", csvMoney(data.expenses_total), ""],
    ["Orçamentos aprovados (R$)", csvMoney(data.quotes_approved_total), ""],
    ...(payouts
      ? [
          ["Valor dos técnicos, pago (R$)", csvMoney(payouts.paid), ""],
          ["Valor dos técnicos, a pagar (R$)", csvMoney(payouts.to_pay), ""],
        ]
      : []),
    [],
    ["Dia", "Entraram", "Resolvidos", "Cancelados", "Improdutivos"],
    ...data.days.map((d) => [brDate(d.date), d.opened, d.resolved, d.cancelled, d.unproductive]),
    ["Total", total.opened, total.resolved, total.cancelled, total.unproductive],
    [],
    ...rankingRows(data, scope),
  ]);
}

/** Texto do fechamento para colar no grupo dos gestores no WhatsApp. */
function dailyText(data: DailyReport, partial: boolean, time: string, scope: CustomerScope | null): string {
  const n = data.numbers;
  const p = data.previous;
  const { flow, stock } = comparison("day", partial);
  const line = (label: string, value: number, previous: number, labels: CompareLabels) =>
    `${label}: ${intFmt(value)} (${deltaText(value, previous, labels)})`;
  const who = scope ? ` · ${scope.name}` : "";
  return [
    partial ? `*Hoje, ${brDate(data.date)}, até as ${time}${who}*` : `*Fechamento de ${brDate(data.date)}${who}*`,
    line("Entraram", n.opened, p.opened, flow),
    line("Resolvidos", n.resolved, p.resolved, flow),
    line("Cancelados", n.cancelled, p.cancelled, flow),
    line("Improdutivos", n.unproductive, p.unproductive, flow),
    line(partial ? "Agendados agora" : "Ficaram agendados", n.scheduled_end, p.scheduled_end, stock),
    line(partial ? "Em aberto agora" : "Em aberto no fechamento", n.backlog_end, p.backlog_end, stock),
    `Resolvidos no prazo: ${intFmt(n.resolved_in_sla)}`,
    n.arrival_on_time_pct === null ? null : `Chegada no prazo: ${pctFmt(n.arrival_on_time_pct)}`,
    data.top_customer && !scope
      ? `Cliente destaque: ${data.top_customer.name} (${plural(data.top_customer.count, "chamado", "chamados")})`
      : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

export default function ReportsPage() {
  const { user } = useAuth();
  if (user && !canManageTickets(user.role)) return <ErrorBox message="Relatórios são da gestão." />;
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Relatórios"
        description="Fechamento do dia (fecha à meia-noite), o consolidado do mês e as violações de SLA."
      />
      {/* useSearchParams pede um Suspense em volta. */}
      <Suspense fallback={<LoadingBlock />}>
        <Reports />
      </Suspense>
    </div>
  );
}

function Reports() {
  const params = useSearchParams();
  const now = useNow(60_000);
  const today = dayISO(now);
  const currentMonth = today.slice(0, 7);
  const aba = params.get("aba");
  const tab: Tab = aba === "mensal" || aba === "sla" ? aba : "diario";
  // Sem dia na URL: o dia anterior (o último fechado), como a API.
  const dia = params.get("dia");
  const day = isDay(dia) && dia <= today ? dia : shiftDay(today, -1);
  const mes = params.get("mes");
  const month = mes && MONTH_RE.test(mes) && mes <= currentMonth ? mes : currentMonth;
  const dias = Number(params.get("dias"));
  const slaDays = SLA_DAYS.includes(dias) ? dias : 30;
  return (
    <>
      <div className="mb-5 border-b border-line">
        <Tabs<Tab>
          className="-mb-px"
          items={[
            { key: "diario", label: "Diário" },
            { key: "mensal", label: "Mensal" },
            { key: "sla", label: "Violações de SLA" },
          ]}
          value={tab}
          onChange={(key) => setParams({ aba: key === "diario" ? null : key })}
          ariaLabel="Relatórios"
        />
      </div>
      {tab === "diario" ? (
        <DailyView day={day} today={today} onDay={(d) => setParams({ dia: d })} />
      ) : tab === "mensal" ? (
        <MonthlyView month={month} today={today} onMonth={(m) => setParams({ mes: m === currentMonth ? null : m })} />
      ) : (
        <SlaView days={slaDays} onDays={(d) => setParams({ dias: d === 30 ? null : String(d) })} />
      )}
    </>
  );
}

/** Quantos entraram, saíram e como o período terminou (comparado com o anterior). */
function Tiles({ n, prev, partial, period }: { n: DayNumbers; prev: DayNumbers; partial: boolean; period: "day" | "month" }) {
  const { flow, stock } = comparison(period, partial);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <StatTile label="Chamados que entraram" value={n.opened} previous={prev.opened} {...flow} />
      <StatTile label="Resolvidos" value={n.resolved} previous={prev.resolved} {...flow} />
      <StatTile label="Cancelados" value={n.cancelled} previous={prev.cancelled} {...flow} />
      <StatTile label="Improdutivos" value={n.unproductive} previous={prev.unproductive} {...flow} />
      <StatTile label={partial ? "Agendados agora" : "Ficaram agendados"} value={n.scheduled_end} previous={prev.scheduled_end} {...stock} />
      <StatTile
        label={partial ? "Em aberto agora" : "Em aberto no fechamento"}
        value={n.backlog_end}
        previous={prev.backlog_end}
        {...stock}
      />
    </div>
  );
}

/** O cliente destaque e as promessas do chamado (solução, chegada e tempo na loja), medidas no período. */
function DeadlineTiles({
  n,
  prev,
  partial,
  period,
  top,
}: {
  n: DayNumbers;
  prev: DayNumbers;
  partial: boolean;
  period: "day" | "month";
  top: ReportCountRef | null;
}) {
  const { flow } = comparison(period, partial);
  const pct = n.arrival_on_time_pct;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      <StatTile
        label={period === "day" ? "Cliente destaque do dia" : "Cliente destaque do mês"}
        value={top?.count ?? 0}
        display={top?.name ?? "—"}
        compact
        hint={top ? plural(top.count, "chamado aberto", "chamados abertos") : "Nenhum chamado aberto"}
        href={top?.id ? `/chamados?customer_id=${top.id}` : undefined}
      />
      <StatTile
        label="Resolvidos no prazo"
        value={n.resolved_in_sla}
        previous={prev.resolved_in_sla}
        {...flow}
        hint="Entre as OS com prazo de solução"
      />
      <StatTile
        label="Chegada no prazo"
        value={pct ?? 0}
        display={pct === null ? "—" : pctFmt(pct)}
        tone={pct === null || pct >= TARGET ? undefined : pct >= FLOOR ? "warning" : "danger"}
        hint={
          n.arrivals === 0
            ? "Nenhuma chegada no período"
            : pct === null
              ? "Nenhuma chegada com prazo"
              : "Sobre as chegadas com prazo (4h nas capitais)"
        }
      />
      <StatTile
        label="Tempo médio até chegar"
        value={n.avg_arrival_minutes ?? 0}
        display={n.avg_arrival_minutes === null ? "—" : formatMinutes(n.avg_arrival_minutes)}
        hint="Da abertura da OS à chegada"
      />
      <StatTile
        label="Tempo médio na loja"
        value={n.avg_onsite_minutes ?? 0}
        display={n.avg_onsite_minutes === null ? "—" : formatMinutes(n.avg_onsite_minutes)}
        hint="Por OS resolvida, somando as visitas"
      />
    </div>
  );
}

function Panels({ data, period }: { data: DailyReport | MonthlyReport; period: string }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="p-4">
        <SectionTitle wrap className="mb-3">
          Clientes com mais chamados {period}
        </SectionTitle>
        <RankBars
          items={data.customers}
          empty="Nenhum chamado aberto."
          label={`Clientes com mais chamados ${period}`}
          href={(item) => (item.id ? `/chamados?customer_id=${item.id}` : undefined)}
        />
      </Card>
      <Card className="p-4">
        {/* Quem mudou a OS para resolvida: o técnico pelo app ou o analista pela central. */}
        <SectionTitle wrap className="mb-3">
          OS resolvidas por pessoa
        </SectionTitle>
        <RankBars items={data.technicians} empty="Nenhuma OS resolvida." label="OS resolvidas por pessoa" />
      </Card>
      <Card className="p-4">
        <SectionTitle wrap className="mb-3">
          Motivos das visitas improdutivas
        </SectionTitle>
        <RankBars items={data.unproductive_reasons} empty="Nenhuma visita improdutiva." label="Motivos das visitas improdutivas" />
      </Card>
    </div>
  );
}

function DailyView({ day, today, onDay }: { day: string; today: string; onDay: (day: string | null) => void }) {
  const { toast } = useToast();
  const report = useQuery({
    queryKey: ["reports", "daily", day],
    queryFn: () => api.get<DailyReport>("/reports/daily", { date: day }),
    placeholderData: keepPreviousData,
  });
  // O campo guarda o que está sendo digitado (o ano, dígito a dígito, passa por 0002, 0020...): o dia
  // só muda com uma data que existe e não está no futuro.
  const [draft, setDraft] = useState({ day, value: day });
  const data = report.data;
  const isToday = day === today;
  const yesterday = shiftDay(today, -1);
  const stale = report.isPlaceholderData;
  const partial = data?.date === today;

  const copySummary = async () => {
    if (!data) return;
    const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: OPERATION_TZ }).format(new Date());
    const copied = await copyText(dailyText(data, partial, time));
    toast(
      copied
        ? { title: "Resumo copiado: cole no grupo do WhatsApp", tone: "success" }
        : { title: "Não foi possível copiar o resumo", description: "Tente de novo.", tone: "error" },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-ink first-letter:uppercase">{longDate(day)}</h2>
          <p className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
            <Moon className="size-3.5" aria-hidden />
            {isToday ? "Hoje: parcial, fecha à meia-noite" : "Dia fechado à meia-noite"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => onDay(shiftDay(day, -1))} aria-label="Dia anterior" title="Dia anterior">
            <ChevronLeft className="size-4" />
          </Button>
          <Input
            type="date"
            value={draft.day === day ? draft.value : day}
            min="2020-01-01"
            max={today}
            onChange={(e) => {
              const value = e.target.value;
              setDraft({ day, value });
              if (isDay(value) && value <= today) onDay(value);
            }}
            className="w-40"
            aria-label="Dia"
          />
          <Button disabled={day >= today} onClick={() => onDay(shiftDay(day, 1))} aria-label="Próximo dia" title="Próximo dia">
            <ChevronRight className="size-4" />
          </Button>
          <Button variant={day === yesterday ? "secondary" : "ghost"} aria-pressed={day === yesterday} onClick={() => onDay(null)}>
            Ontem
          </Button>
          <Button variant={isToday ? "secondary" : "ghost"} aria-pressed={isToday} onClick={() => onDay(today)}>
            Hoje
          </Button>
          <Button disabled={!data || stale} onClick={copySummary}>
            <Copy className="size-4" />
            Copiar resumo
          </Button>
          <Button disabled={!data || stale} onClick={() => data && exportDaily(data, partial)}>
            <Download className="size-4" />
            Exportar CSV
          </Button>
        </div>
      </div>
      {report.error ? <ErrorBox message={errorMessage(report.error)} /> : null}
      {data ? (
        <div className={clsx("flex flex-col gap-4 transition-opacity duration-150", stale && "opacity-60")} aria-busy={report.isFetching}>
          <Tiles n={data.numbers} prev={data.previous} partial={partial} period="day" />
          <DeadlineTiles n={data.numbers} prev={data.previous} partial={partial} period="day" top={data.top_customer} />
          <Panels data={data} period="no dia" />
        </div>
      ) : report.isLoading ? (
        <LoadingBlock />
      ) : null}
    </div>
  );
}

function DaysTable({ days }: { days: ReportDayPoint[] }) {
  const total = days.reduce(
    (t, d) => ({ opened: t.opened + d.opened, resolved: t.resolved + d.resolved, cancelled: t.cancelled + d.cancelled, unproductive: t.unproductive + d.unproductive }),
    { opened: 0, resolved: 0, cancelled: 0, unproductive: 0 },
  );
  const head = "py-1.5 text-xs font-semibold text-ink-muted";
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-sm tabular-nums">
        <caption className="sr-only">Chamados por dia: entraram, resolvidos, cancelados e improdutivos</caption>
        <thead className="sticky top-0 bg-surface text-left">
          <tr>
            <th scope="col" className={head}>
              Dia
            </th>
            <th scope="col" className={clsx(head, "text-right")}>
              Entraram
            </th>
            <th scope="col" className={clsx(head, "text-right")}>
              Resolvidos
            </th>
            <th scope="col" className={clsx(head, "text-right")}>
              Cancelados
            </th>
            <th scope="col" className={clsx(head, "text-right")}>
              Improdutivos
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {days.map((d) => (
            <tr key={d.date}>
              <th scope="row" className="py-1.5 text-left font-normal text-ink">
                {shortDay(d.date)}
              </th>
              <td className="py-1.5 text-right text-ink">{intFmt(d.opened)}</td>
              <td className="py-1.5 text-right text-ink">{intFmt(d.resolved)}</td>
              <td className="py-1.5 text-right text-ink">{intFmt(d.cancelled)}</td>
              <td className="py-1.5 text-right text-ink">{intFmt(d.unproductive)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-line-strong font-semibold text-ink">
          <tr>
            <th scope="row" className="py-1.5 text-left">
              Total
            </th>
            <td className="py-1.5 text-right">{intFmt(total.opened)}</td>
            <td className="py-1.5 text-right">{intFmt(total.resolved)}</td>
            <td className="py-1.5 text-right">{intFmt(total.cancelled)}</td>
            <td className="py-1.5 text-right">{intFmt(total.unproductive)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function MonthlyView({ month, today, onMonth }: { month: string; today: string; onMonth: (month: string) => void }) {
  const [table, setTable] = useState(false);
  const report = useQuery({
    queryKey: ["reports", "monthly", month],
    queryFn: () => api.get<MonthlyReport>("/reports/monthly", { month }),
    placeholderData: keepPreviousData,
  });
  // Valor por chamado das OS concluídas no mês (o mesmo período do fechamento em Pagamentos).
  const payouts = useQuery({
    queryKey: ["payouts", "month", month],
    queryFn: () => api.get<PayoutList>("/payouts", monthDays(month)),
    placeholderData: keepPreviousData,
  });
  const options = useMemo(() => monthOptions(today.slice(0, 7), month), [today, month]);
  const data = report.data;
  const stale = report.isPlaceholderData;
  const partial = !!data && !data.closed;
  const days = data?.days ?? [];
  const series = [
    { key: "opened", label: "Entraram", color: "var(--viz-1)", values: days.map((d) => d.opened) },
    { key: "resolved", label: "Resolvidos", color: "var(--viz-2)", values: days.map((d) => d.resolved) },
  ];
  const summary = payouts.data?.summary;
  const techniciansTotal = summary ? summary.paid + summary.to_pay : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-ink">{monthName(month)}</h2>
          <p className="text-xs text-ink-muted">{month === today.slice(0, 7) ? "Mês em andamento (até hoje)" : "Mês fechado"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={month} onChange={(e) => onMonth(e.target.value)} className="w-52" aria-label="Mês">
            {options.map((m) => (
              <option key={m} value={m}>
                {monthName(m)}
              </option>
            ))}
          </Select>
          <Button disabled={!data || stale} onClick={() => data && exportMonthly(data, partial, summary)}>
            <Download className="size-4" />
            Exportar CSV
          </Button>
        </div>
      </div>
      {report.error ? <ErrorBox message={errorMessage(report.error)} /> : null}
      {data ? (
        <div className={clsx("flex flex-col gap-4 transition-opacity duration-150", stale && "opacity-60")} aria-busy={report.isFetching}>
          <Tiles n={data.numbers} prev={data.previous} partial={partial} period="month" />
          <DeadlineTiles n={data.numbers} prev={data.previous} partial={partial} period="month" top={data.top_customer} />
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile
              label="Custos extras no mês"
              value={data.expenses_total}
              display={formatMoney(data.expenses_total)}
              hint="Lançados no mês, sem os recusados"
            />
            <StatTile
              label="Orçamentos aprovados"
              value={data.quotes_approved_total}
              display={formatMoney(data.quotes_approved_total)}
              hint="Aprovados pelo cliente no mês"
            />
            <StatTile
              label="Valor dos técnicos"
              value={techniciansTotal}
              display={payouts.error ? "—" : formatMoney(techniciansTotal)}
              loading={payouts.isLoading}
              hint={summary ? `pago ${formatMoney(summary.paid)} · a pagar ${formatMoney(summary.to_pay)}` : "OS concluídas no mês"}
              href="/pagamentos"
            />
          </div>
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                <SectionTitle>Chamados por dia</SectionTitle>
                <Legend series={series} />
              </div>
              <Button size="sm" variant="ghost" aria-pressed={table} onClick={() => setTable((v) => !v)}>
                <Table2 className="size-4" />
                {table ? "Ver gráfico" : "Ver tabela"}
              </Button>
            </div>
            {table ? (
              <DaysTable days={days} />
            ) : (
              <TrendChart
                labels={days.map((d) => d.date.slice(8, 10))}
                series={series}
                formatLabel={(i) => shortDay(days[i].date)}
                partialLast={partial && days.at(-1)?.date === today}
              />
            )}
          </Card>
          <Panels data={data} period="no mês" />
        </div>
      ) : report.isLoading ? (
        <LoadingBlock />
      ) : null}
    </div>
  );
}

function SlaView({ days, onDays }: { days: number; onDays: (days: number) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-ink">Últimos {days} dias</h2>
          <p className="text-xs text-ink-muted">OS criadas no período: o motivo de cada prazo estourado e de quem foi a responsabilidade.</p>
        </div>
        <Select value={String(days)} onChange={(e) => onDays(Number(e.target.value))} className="w-48" aria-label="Período">
          {SLA_DAYS.map((d) => (
            <option key={d} value={d}>
              Últimos {d} dias
            </option>
          ))}
        </Select>
      </div>
      <SlaViolationsCard days={days} />
    </div>
  );
}
