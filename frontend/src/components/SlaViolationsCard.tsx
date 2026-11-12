"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { Card, CardHeader, ErrorBox, LoadingBlock } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { RESPONSIBILITY } from "@/lib/constants";
import type { ClockViolations, Responsibility, SlaViolationReport } from "@/lib/types";

function Clock({ title, data }: { title: string; data: ClockViolations }) {
  const max = Math.max(1, ...data.by_reason.map((r) => r.count));
  return (
    <div>
      <p className="text-sm font-medium text-ink">
        {title}: {data.breached} violação(ões)
        <span className="ml-1 text-xs font-normal text-ink-muted">· {data.justified} com motivo</span>
      </p>
      {data.by_reason.length === 0 ? (
        <p className="mt-2 text-xs text-ink-muted">Nenhum motivo registrado no período.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {data.by_reason.map((r) => (
            <li key={r.reason_id} className="grid grid-cols-[1fr_auto] items-center gap-2 text-sm">
              <div>
                <p className="truncate text-ink">{r.name}</p>
                <div className="mt-0.5 h-1.5 rounded-full bg-surface-2">
                  <div
                    className="h-1.5 rounded-full"
                    style={{ width: `${(r.count / max) * 100}%`, backgroundColor: RESPONSIBILITY[r.responsibility].color }}
                  />
                </div>
              </div>
              <span className="font-medium text-ink">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Violações de SLA por motivo e por responsabilidade (o motivo vira estatística, não desculpa). */
export function SlaViolationsCard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["reports", "sla-violations"],
    queryFn: () => api.get<SlaViolationReport>("/reports/sla-violations", { days: 30 }),
  });
  const totalByResp = data ? Object.values(data.by_responsibility).reduce((a, b) => a + b, 0) : 0;

  return (
    <Card>
      <CardHeader
        title="Violações de SLA por motivo"
        description={data ? `OS abertas nos últimos ${data.period_days} dias (${data.tickets_total})` : "Últimos 30 dias"}
        actions={
          data && data.pending_justification > 0 ? (
            <Link
              href="/chamados?violation_pending=true"
              className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:underline dark:bg-amber-500/10 dark:text-amber-300"
            >
              <AlertTriangle className="size-3.5" />
              {data.pending_justification} pendente(s) de justificativa
            </Link>
          ) : null
        }
      />
      {isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <div className="p-4">
          <ErrorBox message={errorMessage(error)} />
        </div>
      ) : data ? (
        <div className="grid gap-5 p-4 md:grid-cols-3">
          <Clock title="1ª resposta" data={data.response} />
          <Clock title="Solução" data={data.resolution} />
          <div>
            <p className="text-sm font-medium text-ink">Por responsabilidade</p>
            {totalByResp === 0 ? (
              <p className="mt-2 text-xs text-ink-muted">Sem motivos registrados ainda.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {(Object.keys(RESPONSIBILITY) as Responsibility[]).map((key) => {
                  const n = data.by_responsibility[key] ?? 0;
                  const pct = Math.round((n / totalByResp) * 100);
                  return (
                    <li key={key} className="text-sm">
                      <div className="flex justify-between">
                        <span className="text-ink">{RESPONSIBILITY[key].label}</span>
                        <span className="text-ink-muted">
                          {n} · {pct}%
                        </span>
                      </div>
                      <div className="mt-0.5 h-1.5 rounded-full bg-surface-2">
                        <div
                          className="h-1.5 rounded-full"
                          style={{ width: `${pct}%`, backgroundColor: RESPONSIBILITY[key].color }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
