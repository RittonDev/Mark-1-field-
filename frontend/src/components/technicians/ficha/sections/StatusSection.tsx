"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Button, ErrorBox, Pill, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { APP_ACCESS, OPERATIONAL_STATUS } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import { OPERATIONAL_STATUS_COLOR, technicianHref } from "@/lib/technicians";
import type { OperationalStatus, Technician, UserChange } from "@/lib/types";
import { StatusDialog } from "../../StatusDialog";
import { fichaLabel } from "../FichaNav";
import { SectionCard, SubTitle } from "../SectionCard";

/** Cor neutra do selo "Ativo" (cor só para problema). */
const NEUTRAL = "#64748b";

/** As ações de cada situação, na ordem dos botões. */
const ACTIONS: Record<OperationalStatus, OperationalStatus[]> = {
  active: ["inactive", "blocked"],
  inactive: ["active", "blocked"],
  blocked: ["active", "inactive"],
};
const ACTION_LABEL: Record<OperationalStatus, string> = { active: "Reativar", inactive: "Inativar", blocked: "Bloquear" };

/** "25/11/2026 14:30". */
const when = (iso: string | null | undefined) => formatDateTime(iso).replace(",", "");

/** O rótulo gravado no histórico ("Ativo"); a chave crua ("inactive"), se vier, vira o rótulo. */
const statusText = (value: string | null) =>
  value ? (OPERATIONAL_STATUS[value as OperationalStatus] ?? value) : "—";

/**
 * Situação na operação (só a central vê; o técnico nunca): Ativo, Inativo ou Bloqueado, com o motivo, quem e quando, e
 * o histórico das mudanças. É separada do acesso ao app (Credenciais).
 */
export function StatusSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const [target, setTarget] = useState<OperationalStatus | null>(null);
  const status = tech.operational_status ?? "active";
  const history = useQuery({
    queryKey: ["technicians", "changes", tech.id, "operational_status"],
    queryFn: ({ signal }) =>
      api.get<UserChange[]>(`/technicians/${tech.id}/changes`, { field: "operational_status", limit: 20 }, { signal }),
    staleTime: 30_000,
  });
  // A API que ainda não filtra por campo manda o histórico inteiro: só as linhas com a situação.
  const rows = (history.data ?? []).flatMap((row) => {
    const item = row.changes.find((c) => c.field === "operational_status");
    return item ? [{ row, item }] : [];
  });

  return (
    <SectionCard title={fichaLabel("situacao")}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <Pill color={status === "active" ? NEUTRAL : OPERATIONAL_STATUS_COLOR[status]} className="px-3 py-1 text-sm">
            {OPERATIONAL_STATUS[status]}
          </Pill>
          {canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              {ACTIONS[status].map((next) => (
                <Button key={next} size="sm" variant={next === "active" ? "primary" : "secondary"} onClick={() => setTarget(next)}>
                  {ACTION_LABEL[next]}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        {status !== "active" ? (
          <div className="flex flex-col gap-0.5 text-sm">
            {tech.operational_reason ? <p className="break-words text-ink">Motivo: {tech.operational_reason}</p> : null}
            {tech.operational_changed_at ? (
              <p className="text-xs text-ink-muted">
                Desde {when(tech.operational_changed_at)}
                {tech.operational_changed_by ? `, por ${tech.operational_changed_by.name}` : ""}
              </p>
            ) : null}
          </div>
        ) : null}
        <p className="text-sm text-ink">
          Acesso ao app: {tech.is_active ? APP_ACCESS.on : APP_ACCESS.off}
          {" · "}
          <Link
            href={technicianHref(tech.id, "credenciais")}
            replace
            scroll={false}
            className="rounded font-medium text-ink underline-offset-2 hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          >
            Credenciais
          </Link>
        </p>
      </div>

      <section className="flex flex-col gap-2 border-t border-line pt-5">
        <SubTitle>Histórico da situação</SubTitle>
        {history.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : history.error ? (
          <ErrorBox message={errorMessage(history.error)} onRetry={() => void history.refetch()} />
        ) : !rows.length ? (
          <p className="text-sm text-ink-muted">Sem mudanças de situação.</p>
        ) : (
          <ol className="divide-y divide-line">
            {rows.map(({ row, item }) => (
              <li key={row.id} className="py-2 text-sm first:pt-0 last:pb-0">
                <p className="text-ink">
                  <time dateTime={row.created_at}>{when(row.created_at)}</time> · {statusText(item.from)} →{" "}
                  {statusText(item.to)}
                  <span className="text-ink-muted"> · {row.actor ? `por ${row.actor.name}` : "pela central"}</span>
                </p>
                {row.note ? <p className="text-xs break-words text-ink-muted">Motivo: {row.note}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {target ? <StatusDialog tech={tech} target={target} onClose={() => setTarget(null)} /> : null}
    </SectionCard>
  );
}
