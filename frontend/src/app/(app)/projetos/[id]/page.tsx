"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, Pencil } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "@/components/badges";
import { ProjectDialog } from "@/components/ProjectDialog";
import { Button, Card, CardHeader, ErrorBox, LoadingBlock, Pill, SectionTitle, Table, Td, Th } from "@/components/ui";
import { QuickEditButton } from "@/components/ticket/QuickEditButton";
import { TicketLink } from "@/components/ticket/TicketLink";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatMoney, formatShort, todayISO } from "@/lib/format";
import { plannedTickets, PROJECT_STATUS, projectLate } from "@/lib/projects";
import type { Page, Project, TicketListItem } from "@/lib/types";

const TICKETS_SHOWN = 200;

/** Indicador da ficha (o mesmo das fichas de cliente e de loja). */
function Stat({ label, value, hint, problem = false }: { label: string; value: string; hint?: string; problem?: boolean }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs font-semibold text-ink/80">{label}</p>
      <p className={clsx("mt-1 text-xl font-semibold tracking-tight tabular-nums", problem ? "text-red-600 dark:text-red-400" : "text-ink")}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-ink-muted">{hint}</p> : null}
    </Card>
  );
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [editing, setEditing] = useState(false);
  // Hoje no fuso da operação (a entrega prevista é um dia do calendário).
  const [today] = useState(todayISO);
  const project = useQuery({ queryKey: ["project", id], queryFn: () => api.get<Project>(`/projects/${id}`) });
  const tickets = useQuery({
    queryKey: ["tickets", "project", id],
    queryFn: () => api.get<Page<TicketListItem>>("/tickets", { project_id: id, page_size: TICKETS_SHOWN, order_by: "-created_at" }),
  });

  const back = (
    <Link href="/projetos" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
      <ArrowLeft className="size-4" />
      Projetos
    </Link>
  );
  if (project.isLoading) return <LoadingBlock />;
  if (project.error || !project.data) {
    return (
      <div className="mx-auto max-w-7xl">
        {back}
        <ErrorBox message={errorMessage(project.error)} onRetry={() => void project.refetch()} />
      </div>
    );
  }
  const p = project.data;
  const info = PROJECT_STATUS[p.status];
  const late = projectLate(p, today);
  const items = tickets.data?.items ?? [];
  const totalTickets = tickets.data?.total ?? 0;
  const progress = Math.round(p.stats.progress * 100);

  return (
    <div className="mx-auto max-w-7xl">
      {back}
      <Card className="mb-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 font-mono text-sm text-ink-muted">
              {p.code}
              <Pill color={info.color} className="font-sans">
                <span className="size-1.5 rounded-full" style={{ backgroundColor: info.color }} />
                {info.label}
              </Pill>
            </p>
            <h1 className="mt-1 text-[22px] leading-tight font-bold tracking-[-0.02em] text-ink">{p.name}</h1>
            <span aria-hidden className="brand-gradient mt-2 block h-[3px] w-10 rounded-full" />
            <p className="mt-1.5 text-sm text-ink-muted">
              {[p.customer?.name, p.start_date && `de ${formatDate(p.start_date)}`].filter(Boolean).join(" · ")}
              {p.end_date ? (
                <span className={late ? "font-medium text-red-600 dark:text-red-400" : undefined}>
                  {p.customer?.name || p.start_date ? " · " : ""}
                  entrega até {formatDate(p.end_date)}
                  {late ? " (atrasada)" : ""}
                </span>
              ) : null}
            </p>
          </div>
          <Button onClick={() => setEditing(true)}>
            <Pencil className="size-4" />
            Editar
          </Button>
        </div>
        <div className="mt-4">
          <div className="flex flex-wrap justify-between gap-x-3 text-xs text-ink-muted">
            <span>
              {p.stats.tickets_done} de {plannedTickets(p.stats)} OS concluídas · {p.stats.tickets_open} em aberto
              {p.stats.tickets_cancelled
                ? ` · ${p.stats.tickets_cancelled} ${p.stats.tickets_cancelled === 1 ? "cancelada" : "canceladas"}`
                : ""}
              {p.stats.unproductive
                ? ` · ${p.stats.unproductive} ${p.stats.unproductive === 1 ? "visita improdutiva" : "visitas improdutivas"}`
                : ""}
            </span>
            <span className="tabular-nums">{progress}%</span>
          </div>
          <div
            className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-label="OS concluídas"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div className="h-full rounded-full bg-brand" style={{ width: `${p.stats.progress * 100}%` }} />
          </div>
        </div>
      </Card>

      <div className="stagger mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Stat label="Valor do projeto" value={p.contract_value != null ? formatMoney(p.contract_value) : "—"} />
        <Stat label="Custos extras" value={formatMoney(p.stats.expenses_total)} hint="lançados nas OS do projeto" />
        <Stat label="Valor dos técnicos" value={formatMoney(p.stats.payouts_total ?? 0)} hint="pago e a pagar, por OS" />
        <Stat
          label="Margem"
          value={p.margin != null ? formatMoney(p.margin) : "—"}
          hint="valor menos os custos e os técnicos"
          problem={p.margin != null && p.margin < 0}
        />
        <Stat label="Orçamentos aprovados" value={formatMoney(p.stats.quotes_approved_total)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader
            title="OS do projeto"
            description={
              totalTickets > items.length
                ? `Mostrando as ${items.length} mais recentes de ${totalTickets.toLocaleString("pt-BR")}`
                : undefined
            }
          />
          {tickets.isLoading ? (
            <LoadingBlock />
          ) : tickets.error ? (
            <div className="p-4">
              <ErrorBox message={errorMessage(tickets.error)} onRetry={() => void tickets.refetch()} />
            </div>
          ) : items.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-muted">
              Nenhuma OS marcada com este projeto. Marque o projeto ao abrir a OS (Nova OS) ou no editor da OS.
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>OS</Th>
                  <Th className="hidden md:table-cell">Local</Th>
                  <Th className="hidden sm:table-cell">Técnico</Th>
                  <Th className="hidden xl:table-cell">Analista</Th>
                  <Th className="hidden lg:table-cell">Agendada</Th>
                  <Th>Status</Th>
                  <Th className="edit-col">Editar</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id} className="transition-colors hover:bg-[var(--row-hover)]">
                    <Td>
                      <TicketLink ticketId={t.id} className="font-mono text-xs text-brand hover:underline">
                        {t.code}
                      </TicketLink>
                      <span className="block max-w-72 truncate font-semibold text-ink">{t.title}</span>
                    </Td>
                    <Td className="hidden text-sm md:table-cell">{t.location?.name ?? "—"}</Td>
                    <Td className="hidden text-sm sm:table-cell">{t.assignee?.name ?? "—"}</Td>
                    <Td className="hidden text-sm xl:table-cell">{t.owner?.name ?? "—"}</Td>
                    <Td className="hidden text-xs whitespace-nowrap text-ink-muted lg:table-cell">{formatShort(t.scheduled_start)}</Td>
                    <Td>
                      <StatusBadge status={t.status} />
                    </Td>
                    <Td className="edit-col">
                      <QuickEditButton ticketId={t.id} code={t.code} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <div className="flex flex-col gap-4">
          <Card className="p-4 text-sm">
            <SectionTitle as="h2" className="mb-2">Equipe</SectionTitle>
            <p className="text-ink-muted">Responsável interno: {p.manager?.name ?? "—"}</p>
            <p className="text-ink-muted">Grupo técnico: {p.team?.name ?? "—"}</p>
            {p.members.length ? (
              <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Técnicos do projeto">
                {p.members.map((m) => (
                  <li key={m.id} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink">
                    {m.name}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
          {p.pricing_notes ? (
            <Card className="p-4 text-sm">
              <SectionTitle as="h2" className="mb-2">Condições e valores</SectionTitle>
              <p className="whitespace-pre-wrap text-ink-muted">{p.pricing_notes}</p>
            </Card>
          ) : null}
          {p.description ? (
            <Card className="p-4 text-sm">
              <SectionTitle as="h2" className="mb-2">Descrição</SectionTitle>
              <p className="whitespace-pre-wrap text-ink-muted">{p.description}</p>
            </Card>
          ) : null}
        </div>
      </div>
      {editing ? <ProjectDialog project={p} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}
