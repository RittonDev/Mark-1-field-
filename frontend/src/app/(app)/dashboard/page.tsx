"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowRight, Moon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatTile } from "@/components/charts";
import { SlaViolationsCard } from "@/components/SlaViolationsCard";
import { useNow } from "@/components/useNow";
import { Card, CardHeader, ErrorBox, LoadingBlock, PageHeader, SectionTitle, Skeleton, Table, Td, Th } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { PRIORITY, PRIORITY_ORDER, STATUS, STATUS_ORDER } from "@/lib/constants";
import { dayKey, formatMinutes, formatTime } from "@/lib/format";
import type { DailyReport, DashboardSummary, Page, TicketListItem } from "@/lib/types";

/** Meta de prazo: abaixo dela o número fica âmbar; abaixo do piso, vermelho. */
const SLA_TARGET = 90;
const SLA_FLOOR = 75;

const intFmt = (n: number) => n.toLocaleString("pt-BR");

interface BarRow {
  key: string;
  label: string;
  color: string;
  value: number;
  href: string;
}

/** Barras finas (a cor é a do status ou da prioridade); cada linha abre a lista daquelas OS. */
function Bars({ rows, label }: { rows: BarRow[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="flex flex-col p-2" aria-label={label}>
      {rows.map((row) => (
        <li key={row.key}>
          <Link
            href={row.href}
            className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_2.5rem] items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 hover:bg-[var(--row-hover)] focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
          >
            <span className="truncate text-ink-muted" title={row.label}>
              {row.label}
            </span>
            <span className="h-2 overflow-hidden rounded-r bg-surface-2" aria-hidden>
              <span
                className="block h-full rounded-r transition-[width] duration-200"
                style={{ width: `${(row.value / max) * 100}%`, backgroundColor: row.color }}
              />
            </span>
            <span className="text-right font-medium text-ink tabular-nums">{intFmt(row.value)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Hoje até agora": o fechamento do dia em andamento (fecha à meia-noite), o mesmo dos Relatórios.
 * Fora da chave "dashboard": o tempo real não recalcula o relatório a cada evento de OS.
 */
function TodaySoFar({ today }: { today: string }) {
  const report = useQuery({
    queryKey: ["reports", "daily", today],
    queryFn: () => api.get<DailyReport>("/reports/daily", { date: today }),
    refetchInterval: 120_000,
  });
  const data = report.data;
  const top = data?.top_customer ?? null;
  // O dia de hoje ainda está aberto: o que entrou e saiu se compara com ontem inteiro; o que está
  // agendado, com como ontem terminou.
  const flow = { previousLabel: "vs total de ontem", sameLabel: "igual ao total de ontem" };
  return (
    <section className="mt-6">
      <SectionTitle
        as="h2"
        aside={
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
            <Moon className="size-3.5" aria-hidden />
            fecha à meia-noite
          </span>
        }
      >
        Hoje até agora
      </SectionTitle>
      {data ? (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <StatTile label="Entraram" value={data.numbers.opened} previous={data.previous.opened} {...flow} />
          <StatTile label="Resolvidos" value={data.numbers.resolved} previous={data.previous.resolved} {...flow} />
          <StatTile label="Cancelados" value={data.numbers.cancelled} previous={data.previous.cancelled} {...flow} />
          <StatTile label="Improdutivos" value={data.numbers.unproductive} previous={data.previous.unproductive} {...flow} />
          <StatTile
            label="Agendados agora"
            value={data.numbers.scheduled_end}
            previous={data.previous.scheduled_end}
            previousLabel="vs fim de ontem"
            sameLabel="igual ao fim de ontem"
          />
          <StatTile
            label="Cliente destaque"
            value={top?.count ?? 0}
            display={top?.name ?? "—"}
            compact
            hint={top ? `${intFmt(top.count)} ${top.count === 1 ? "chamado" : "chamados"} hoje` : "Nenhum chamado hoje"}
            href={top?.id ? `/chamados?customer_id=${top.id}` : undefined}
          />
        </div>
      ) : report.error ? (
        <div className="mt-3">
          <ErrorBox message={errorMessage(report.error)} onRetry={() => void report.refetch()} />
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" role="status" aria-label="Carregando o dia de hoje">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-xl" />
          ))}
        </div>
      )}
      <p className="mt-2 text-right text-xs">
        <Link href="/relatorios" className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
          Ver o fechamento de ontem
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </p>
    </section>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const now = useNow(60_000);
  const summary = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardSummary>("/dashboard/summary"),
    refetchInterval: 60_000,
  });
  // OS em aberto sem analista responsável: ninguém da central acompanhando.
  const noOwner = useQuery({
    queryKey: ["dashboard", "no-owner"],
    queryFn: () => api.get<Page<TicketListItem>>("/tickets", { no_owner: true, open_only: true, page_size: 1 }),
    refetchInterval: 60_000,
  });

  const data = summary.data;
  // Uma falha ao atualizar mantém os números na tela (com o aviso abaixo do título).
  if (!data) {
    return summary.error ? <ErrorBox message={errorMessage(summary.error)} onRetry={() => void summary.refetch()} /> : <LoadingBlock />;
  }

  const openStatuses = STATUS_ORDER.filter((s) => ["open", "active", "pending"].includes(STATUS[s].group));
  const statusRows = openStatuses.map((s) => ({
    key: s,
    label: STATUS[s].label,
    color: STATUS[s].color,
    value: data.by_status[s] ?? 0,
    href: `/chamados?status=${s}`,
  }));
  const priorityRows = PRIORITY_ORDER.map((p) => ({
    key: p,
    label: `${PRIORITY[p].code} · ${PRIORITY[p].label}`,
    color: PRIORITY[p].color,
    value: data.by_priority[p] ?? 0,
    href: `/chamados?priority=${p}&open_only=true`,
  }));
  const compliance = data.sla_compliance_30d;
  const noOwnerCount = noOwner.data?.total ?? 0;
  const loadOf = (userId: string) => `/chamados?assignee_id=${userId}&open_only=true`;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Dashboard" description="A operação agora, o dia até aqui e os últimos 30 dias. Atualiza em tempo real." />
      {summary.error ? (
        <p role="status" className="-mt-3 mb-4 text-xs text-ink-muted">
          Sem conexão com o servidor: mostrando os números das {formatTime(new Date(summary.dataUpdatedAt).toISOString())}. Tentando de
          novo.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Chamados abertos" value={data.open_total} href="/chamados?open_only=true" hint="Ainda não resolvidos" />
        <StatTile
          label="Sem técnico"
          value={data.unassigned}
          tone={data.unassigned > 0 ? "warning" : undefined}
          href="/chamados?unassigned=true"
          hint="Abertos sem técnico definido"
        />
        <StatTile
          label="Sem analista"
          value={noOwnerCount}
          display={noOwner.error ? "—" : undefined}
          loading={noOwner.isLoading}
          tone={noOwnerCount > 0 ? "warning" : undefined}
          href="/chamados?no_owner=true"
          hint="Abertos sem analista responsável"
        />
        <StatTile
          label="SLA violado"
          value={data.sla_breached}
          tone={data.sla_breached > 0 ? "danger" : undefined}
          href="/chamados?sla_breached=true"
          hint="Abertos com o prazo estourado"
        />
        <StatTile
          label="SLA em risco"
          value={data.sla_at_risk}
          tone={data.sla_at_risk > 0 ? "warning" : undefined}
          hint="Perto de estourar o prazo"
        />
      </div>

      {/* O dia no fuso da operação: o fechamento vira à meia-noite de lá. */}
      <TodaySoFar today={dayKey(now)} />

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Em aberto por status" description="Clique para ver as OS de cada status" />
          <Bars rows={statusRows} label="OS em aberto por status" />
        </Card>
        <Card>
          <CardHeader title="Em aberto por prioridade" description="Clique para ver as OS de cada prioridade" />
          <Bars rows={priorityRows} label="OS em aberto por prioridade" />
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Carga por técnico" description="OS em aberto de cada técnico (clique para ver a lista)" />
        {data.by_assignee.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">Nenhuma OS em aberto com técnico no momento.</p>
        ) : (
          <Table label="Carga por técnico">
            <thead>
              <tr>
                <Th>Técnico</Th>
                <Th className="text-right">Em aberto</Th>
                <Th className="text-right">
                  <span title="A caminho ou em atendimento">Em campo</span>
                </Th>
                <Th className="text-right">SLA violado</Th>
              </tr>
            </thead>
            <tbody>
              {data.by_assignee.map((row) => (
                <tr
                  key={row.user_id}
                  onClick={(e) => {
                    if (e.currentTarget.contains(e.target as Node)) router.push(loadOf(row.user_id));
                  }}
                  className="cursor-pointer transition-colors hover:bg-[var(--row-hover)]"
                >
                  <Td>
                    <Link href={loadOf(row.user_id)} onClick={(e) => e.stopPropagation()} className="font-semibold hover:text-brand">
                      {row.name}
                    </Link>
                  </Td>
                  <Td className="text-right tabular-nums">{intFmt(row.open)}</Td>
                  <Td className="text-right tabular-nums">{intFmt(row.in_progress)}</Td>
                  <Td className={clsx("text-right tabular-nums", row.breached > 0 && "font-semibold text-red-600 dark:text-red-400")}>
                    {intFmt(row.breached)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <section className="mt-6">
        <SectionTitle as="h2">Últimos 30 dias</SectionTitle>
        <div className="mt-3 grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="grid grid-cols-2 content-start gap-3 lg:grid-cols-1">
            <StatTile
              label="No prazo (30 dias)"
              value={compliance ?? 0}
              display={compliance === null ? "—" : `${compliance.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`}
              tone={compliance === null || compliance >= SLA_TARGET ? undefined : compliance >= SLA_FLOOR ? "warning" : "danger"}
              hint="OS resolvidas dentro do prazo"
            />
            <StatTile
              label="Tempo médio de solução"
              value={data.avg_resolution_minutes_30d ?? 0}
              display={formatMinutes(data.avg_resolution_minutes_30d)}
              hint="Da abertura à solução, sem as pausas"
            />
          </div>
          <SlaViolationsCard />
        </div>
      </section>
    </div>
  );
}
