"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { Card, CardHeader, ErrorBox, LoadingBlock, SectionTitle } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { RESPONSIBILITY } from "@/lib/constants";
import type { ClockViolations, Responsibility, SlaViolationReport } from "@/lib/types";

const intFmt = (n: number) => n.toLocaleString("pt-BR");
const plural = (n: number, one: string, many: string) => `${intFmt(n)} ${n === 1 ? one : many}`;

function Clock({ title, data, total }: { title: string; data: ClockViolations; total: number }) {
  const max = Math.max(1, ...data.by_reason.map((r) => r.count));
  return (
    <div className="min-w-0">
      <SectionTitle>{title}</SectionTitle>
      <p className="mt-0.5 text-xs text-ink-muted">
        <span className="font-semibold text-ink">{plural(data.breached, "violação", "violações")}</span>
        {total > 0 ? ` (${Math.round((data.breached / total) * 100)}% das OS)` : ""} · {intFmt(data.justified)} com motivo
      </p>
      {data.by_reason.length === 0 ? (
        <p className="mt-2 text-xs text-ink-muted">Nenhum motivo registrado no período.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {data.by_reason.map((r) => (
            <li key={r.reason_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-sm">
              <div className="min-w-0">
                <p className="truncate text-ink" title={`${r.name} · ${RESPONSIBILITY[r.responsibility].label}`}>
                  {r.name}
                </p>
                <div className="mt-0.5 h-1.5 rounded-full bg-surface-2" aria-hidden>
                  <div
                    className="h-1.5 rounded-full"
                    style={{ width: `${(r.count / max) * 100}%`, backgroundColor: RESPONSIBILITY[r.responsibility].color }}
                  />
                </div>
              </div>
              <span className="font-medium text-ink tabular-nums">{intFmt(r.count)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Violações de SLA por motivo e por responsabilidade (o motivo vira estatística, não desculpa), nas OS
 * criadas nos últimos `days` dias.
 */
export function SlaViolationsCard({ days = 30 }: { days?: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["reports", "sla-violations", days],
    queryFn: () => api.get<SlaViolationReport>("/reports/sla-violations", { days }),
  });
  const totalByResp = data ? Object.values(data.by_responsibility).reduce((a, b) => a + b, 0) : 0;

  return (
    <Card>
      <CardHeader
        title="Violações de SLA por motivo"
        description={
          data
            ? `${plural(data.tickets_total, "OS criada", "OS criadas")} nos últimos ${data.period_days} dias, sem as canceladas`
            : `Últimos ${days} dias`
        }
        actions={
          data && data.pending_justification > 0 ? (
            <Link
              href="/chamados?violation_pending=true"
              className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:underline dark:bg-amber-500/10 dark:text-amber-300"
            >
              <AlertTriangle className="size-3.5" />
              {plural(data.pending_justification, "pendente de justificativa", "pendentes de justificativa")}
            </Link>
          ) : null
        }
      />
      {/* Com os dados na tela, uma falha ao atualizar não apaga o cartão. */}
      {data ? (
        <div className="grid gap-5 p-4 md:grid-cols-3">
          <Clock title="1ª resposta" data={data.response} total={data.tickets_total} />
          <Clock title="Solução" data={data.resolution} total={data.tickets_total} />
          <div className="min-w-0">
            <SectionTitle>Por responsabilidade</SectionTitle>
            {/* Mesma linha de contagem das outras duas colunas: as listas começam alinhadas. */}
            <p className="mt-0.5 text-xs text-ink-muted">
              {totalByResp === 0 ? (
                "Sem motivos registrados ainda."
              ) : (
                <span className="font-semibold text-ink">{plural(totalByResp, "motivo registrado", "motivos registrados")}</span>
              )}
            </p>
            {totalByResp === 0 ? null : (
              <ul className="mt-2 space-y-2">
                {(Object.keys(RESPONSIBILITY) as Responsibility[]).map((key) => {
                  const n = data.by_responsibility[key] ?? 0;
                  const pct = Math.round((n / totalByResp) * 100);
                  return (
                    <li key={key} className="text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="min-w-0 truncate text-ink">{RESPONSIBILITY[key].label}</span>
                        <span className="shrink-0 text-ink-muted tabular-nums">
                          {intFmt(n)} · {pct}%
                        </span>
                      </div>
                      <div className="mt-0.5 h-1.5 rounded-full bg-surface-2" aria-hidden>
                        <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, backgroundColor: RESPONSIBILITY[key].color }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <div className="p-4">
          <ErrorBox message={errorMessage(error)} />
        </div>
      ) : null}
    </Card>
  );
}
