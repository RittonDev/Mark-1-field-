"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, Pencil } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "@/components/badges";
import { ProjectDialog } from "@/components/ProjectDialog";
import { Button, Card, CardHeader, ErrorBox, LoadingBlock, SectionTitle, Table, Td, Th } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";
import { PROJECT_STATUS } from "@/lib/projects";
import type { Page, Project, TicketListItem } from "@/lib/types";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [editing, setEditing] = useState(false);
  const project = useQuery({ queryKey: ["project", id], queryFn: () => api.get<Project>(`/projects/${id}`) });
  const tickets = useQuery({
    queryKey: ["tickets", "project", id],
    queryFn: () => api.get<Page<TicketListItem>>("/tickets", { project_id: id, page_size: 200, order_by: "-created_at" }),
  });
  if (project.isLoading) return <LoadingBlock />;
  if (!project.data) return <ErrorBox message={errorMessage(project.error)} />;
  const p = project.data;
  const kpis: [string, string, string?][] = [
    ["Valor do projeto", p.contract_value != null ? formatMoney(p.contract_value) : "—"],
    ["Custos extras", formatMoney(p.stats.expenses_total)],
    ["Margem", p.margin != null ? formatMoney(p.margin) : "—", p.margin != null && p.margin < 0 ? "text-red-600 dark:text-red-400" : undefined],
    ["Orçamentos aprovados", formatMoney(p.stats.quotes_approved_total)],
  ];

  return (
    <div className="mx-auto max-w-7xl">
      <Link href="/projetos" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft className="size-4" />
        Projetos
      </Link>
      <Card className="mb-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-mono text-sm text-ink-muted">
              {p.code}
              <span className={clsx("rounded-full px-2 py-0.5 font-sans text-[11px] font-medium", PROJECT_STATUS[p.status].className)}>
                {PROJECT_STATUS[p.status].label}
              </span>
            </p>
            <h1 className="mt-1 text-xl font-bold tracking-[-0.02em] text-ink">{p.name}</h1>
            <p className="mt-1 text-sm text-ink-muted">
              {[p.customer?.name, p.start_date && `de ${formatDate(p.start_date)}`, p.end_date && `até ${formatDate(p.end_date)}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <Button onClick={() => setEditing(true)}>
            <Pencil className="size-4" />
            Editar
          </Button>
        </div>
        <div className="mt-4">
          <div className="flex justify-between text-xs text-ink-muted">
            <span>
              {p.stats.tickets_done} de {p.stats.tickets_total} OS concluídas · {p.stats.tickets_open} em aberto
              {p.stats.unproductive ? ` · ${p.stats.unproductive} visita(s) improdutiva(s)` : ""}
            </span>
            <span className="tabular-nums">{Math.round(p.stats.progress * 100)}%</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2">
            <div className="brand-gradient h-full rounded-full" style={{ width: `${p.stats.progress * 100}%` }} />
          </div>
        </div>
      </Card>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map(([label, value, tone]) => (
          <Card key={label} className="px-4 py-3">
            <p className="text-xs font-semibold text-ink/80">{label}</p>
            <p className={clsx("mt-1 text-xl font-semibold text-ink tabular-nums", tone)}>{value}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader title="OS do projeto" />
          {tickets.isLoading ? (
            <LoadingBlock />
          ) : (tickets.data?.items ?? []).length === 0 ? (
            <p className="px-4 py-4 text-sm text-ink-muted">Nenhuma OS marcada com este projeto. Marque em Nova OS ou em Editar OS.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>OS</Th>
                  <Th className="hidden md:table-cell">Local</Th>
                  <Th className="hidden sm:table-cell">Responsável</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {(tickets.data?.items ?? []).map((t) => (
                  <tr key={t.id}>
                    <Td>
                      <Link href={`/chamados/${t.id}`} className="font-mono text-xs text-brand hover:underline">
                        {t.code}
                      </Link>
                      <span className="block max-w-72 truncate font-semibold text-ink">{t.title}</span>
                    </Td>
                    <Td className="hidden text-sm md:table-cell">{t.location?.name ?? "—"}</Td>
                    <Td className="hidden text-sm sm:table-cell">{t.assignee?.name ?? "—"}</Td>
                    <Td>
                      <StatusBadge status={t.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <div className="flex flex-col gap-4">
          <Card className="p-4 text-sm">
            <SectionTitle className="mb-2">Equipe</SectionTitle>
            <p className="text-ink-muted">Responsável: {p.manager?.name ?? "—"}</p>
            <p className="text-ink-muted">Grupo: {p.team?.name ?? "—"}</p>
            {p.members.length ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {p.members.map((m) => (
                  <li key={m.id} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink">
                    {m.name}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
          {p.pricing_notes || p.description ? (
            <Card className="p-4 text-sm">
              {p.pricing_notes ? (
                <>
                  <SectionTitle className="mb-1">Condições e valores</SectionTitle>
                  <p className="whitespace-pre-wrap text-ink-muted">{p.pricing_notes}</p>
                </>
              ) : null}
              {p.description ? <p className="mt-3 whitespace-pre-wrap text-ink-muted">{p.description}</p> : null}
            </Card>
          ) : null}
        </div>
      </div>
      {editing ? <ProjectDialog project={p} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}
