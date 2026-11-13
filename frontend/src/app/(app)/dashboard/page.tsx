"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import {
  AlarmClockOff,
  CheckCheck,
  Clock,
  Gauge,
  Inbox,
  PlusCircle,
  ShieldAlert,
  UserX,
} from "lucide-react";
import Link from "next/link";
import { CountUp } from "@/components/motion";
import { SlaViolationsCard } from "@/components/SlaViolationsCard";
import { Card, CardHeader, ErrorBox, LoadingBlock, PageHeader, Table, Td, Th } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { PRIORITY, PRIORITY_ORDER, STATUS, STATUS_ORDER } from "@/lib/constants";
import { formatMinutes } from "@/lib/format";
import type { DashboardSummary } from "@/lib/types";

function Kpi({
  label,
  value,
  icon: Icon,
  tone = "default",
  href,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "danger" | "warning" | "success";
  href?: string;
  hint?: string;
}) {
  const content = (
    <div className="flex h-full items-start justify-between gap-3 p-4">
      <div className="min-w-0">
        <p className="text-xs font-medium text-ink-muted">{label}</p>
        <p
          className={clsx(
            "mt-1.5 text-2xl font-semibold tracking-tight tabular-nums",
            tone === "danger" && "text-red-600 dark:text-red-400",
            tone === "warning" && "text-amber-600 dark:text-amber-400",
            tone === "success" && "text-emerald-600 dark:text-emerald-400",
            tone === "default" && "text-ink",
          )}
        >
          {typeof value === "number" ? <CountUp value={value} /> : value}
        </p>
        {hint ? <p className="mt-1 text-[11px] text-ink-muted">{hint}</p> : null}
      </div>
      <div className="rounded-lg bg-surface-2 p-2 text-ink-muted">
        <Icon className="size-4" />
      </div>
    </div>
  );
  return (
    <Card className={clsx("animate-enter", href && "transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-elev-2")}>
      {href ? <Link href={href}>{content}</Link> : content}
    </Card>
  );
}

function Bars({ rows }: { rows: { key: string; label: string; color: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="flex flex-col gap-2.5 p-4">
      {rows.map((row, index) => (
        <div key={row.key} className="grid grid-cols-[9.5rem_1fr_2.5rem] items-center gap-3 text-sm">
          <span className="truncate text-ink-muted" title={row.label}>
            {row.label}
          </span>
          <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="grow-x h-full rounded-full transition-[width] duration-500"
              style={{ width: `${(row.value / max) * 100}%`, backgroundColor: row.color, animationDelay: `${index * 40}ms` }}
            />
          </div>
          <span className="text-right font-medium text-ink tabular-nums">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardSummary>("/dashboard/summary"),
    refetchInterval: 60_000,
  });

  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <ErrorBox message={errorMessage(error)} />;

  const statusRows = STATUS_ORDER.filter((s) => !STATUS[s].final).map((s) => ({
    key: s,
    label: STATUS[s].label,
    color: STATUS[s].color,
    value: data.by_status[s] ?? 0,
  }));
  const priorityRows = PRIORITY_ORDER.map((p) => ({
    key: p,
    label: `${PRIORITY[p].code} · ${PRIORITY[p].label}`,
    color: PRIORITY[p].color,
    value: data.by_priority[p] ?? 0,
  }));
  const compliance = data.sla_compliance_30d;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Dashboard" description="Visão geral da operação em tempo real" />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Chamados abertos" value={data.open_total} icon={Inbox} href="/chamados?open_only=true" />
        <Kpi
          label="Sem responsável"
          value={data.unassigned}
          icon={UserX}
          tone={data.unassigned > 0 ? "warning" : "default"}
          href="/chamados?unassigned=true"
        />
        <Kpi
          label="SLA violado"
          value={data.sla_breached}
          icon={ShieldAlert}
          tone={data.sla_breached > 0 ? "danger" : "default"}
          href="/chamados?sla_breached=true"
        />
        <Kpi
          label="SLA em risco"
          value={data.sla_at_risk}
          icon={AlarmClockOff}
          tone={data.sla_at_risk > 0 ? "warning" : "default"}
        />
        <Kpi label="Criados hoje" value={data.created_today} icon={PlusCircle} />
        <Kpi label="Resolvidos hoje" value={data.resolved_today} icon={CheckCheck} tone={data.resolved_today > 0 ? "success" : "default"} />
        <Kpi
          label="Conformidade SLA (30d)"
          value={compliance === null ? "—" : `${compliance.toFixed(1).replace(".", ",")}%`}
          icon={Gauge}
          tone={compliance === null ? "default" : compliance >= 90 ? "success" : compliance >= 75 ? "warning" : "danger"}
          hint="OS resolvidas dentro do prazo"
        />
        <Kpi
          label="Tempo médio de solução"
          value={formatMinutes(data.avg_resolution_minutes_30d)}
          icon={Clock}
          hint="Últimos 30 dias"
        />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Backlog por status" description="Chamados ainda não encerrados" />
          <Bars rows={statusRows} />
        </Card>
        <Card>
          <CardHeader title="Abertos por prioridade" />
          <Bars rows={priorityRows} />
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Carga por responsável" description="Distribuição das OS em aberto" />
        {data.by_assignee.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">Nenhum chamado atribuído no momento.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Responsável</Th>
                <Th className="text-right">Em aberto</Th>
                <Th className="text-right">Em atendimento</Th>
                <Th className="text-right">SLA violado</Th>
              </tr>
            </thead>
            <tbody>
              {data.by_assignee.map((row) => (
                <tr key={row.user_id} className="hover:bg-surface-2">
                  <Td>
                    <Link href={`/chamados?assignee_id=${row.user_id}`} className="font-medium hover:text-brand">
                      {row.name}
                    </Link>
                  </Td>
                  <Td className="text-right tabular-nums">{row.open}</Td>
                  <Td className="text-right tabular-nums">{row.in_progress}</Td>
                  <Td
                    className={clsx(
                      "text-right tabular-nums",
                      row.breached > 0 && "font-semibold text-red-600 dark:text-red-400",
                    )}
                  >
                    {row.breached}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="mt-4">
        <SlaViolationsCard />
      </div>
    </div>
  );
}
