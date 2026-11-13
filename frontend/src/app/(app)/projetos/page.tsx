"use client";

import clsx from "clsx";
import { FolderKanban, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ProjectDialog } from "@/components/ProjectDialog";
import { Button, Card, EmptyState, ErrorBox, Input, LoadingBlock, PageHeader, Pill, Select } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatMoney, todayISO } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { plannedTickets, PROJECT_STATUS, projectCosts, projectLate, useProjects } from "@/lib/projects";
import { useCustomers } from "@/lib/queries";
import type { ProjectStatus } from "@/lib/types";

export default function ProjectsPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<ProjectStatus | "">("active");
  const [search, setSearch] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [creating, setCreating] = useState(false);
  // Hoje no fuso da operação (a entrega prevista é um dia do calendário, não um instante).
  const [today] = useState(todayISO);
  const q = useDebounced(search.trim(), 300);
  const customers = useCustomers();
  const projects = useProjects({ status: status || undefined, q, customerId: customerId || null });
  if (user && !canManageTickets(user.role)) return <ErrorBox message="Projetos são da gestão." />;
  const list = projects.data ?? [];
  const filtered = Boolean(q || customerId || status);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Projetos"
        description="OS marcadas como de projeto, com valor fechado, equipe própria e o acompanhamento de custo e prazo."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            Novo projeto
          </Button>
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_12rem]">
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar pelo nome ou pela descrição"
            aria-label="Buscar projetos"
            className="pl-9"
          />
        </div>
        <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="Cliente">
          <option value="">Todos os clientes</option>
          {(customers.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus | "")} aria-label="Situação">
          <option value="">Todas as situações</option>
          {Object.entries(PROJECT_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
      </div>
      {projects.isLoading ? (
        <LoadingBlock />
      ) : projects.error && !projects.data ? (
        <ErrorBox message={errorMessage(projects.error)} onRetry={() => void projects.refetch()} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FolderKanban className="size-6" />}
            title={filtered ? "Nenhum projeto com esses filtros" : "Nenhum projeto ainda"}
            description="Crie um projeto e marque as OS dele (em Nova OS ou no editor da OS)."
          />
        </Card>
      ) : (
        <div className={clsx("grid gap-3 transition-opacity duration-150 md:grid-cols-2 xl:grid-cols-3", projects.isPlaceholderData && "opacity-60")}>
          {list.map((p) => {
            const late = projectLate(p, today);
            const info = PROJECT_STATUS[p.status];
            return (
              <Link key={p.id} href={`/projetos/${p.id}`} className="rounded-xl focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none">
                <Card className="flex h-full flex-col p-4 transition-colors hover:border-brand/50">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-ink-muted">{p.code}</p>
                      <h2 className="truncate font-bold text-ink">{p.name}</h2>
                      <p className="truncate text-sm text-ink-muted">{p.customer?.name ?? "Sem cliente"}</p>
                    </div>
                    <Pill color={info.color} className="shrink-0">
                      <span className="size-1.5 rounded-full" style={{ backgroundColor: info.color }} />
                      {info.label}
                    </Pill>
                  </div>
                  <div className="mt-4">
                    <div className="flex justify-between gap-2 text-xs text-ink-muted">
                      <span>
                        {p.stats.tickets_done} de {plannedTickets(p.stats)} OS concluídas
                        {p.stats.tickets_cancelled ? ` · ${p.stats.tickets_cancelled} ${p.stats.tickets_cancelled === 1 ? "cancelada" : "canceladas"}` : ""}
                      </span>
                      <span className="tabular-nums">{Math.round(p.stats.progress * 100)}%</span>
                    </div>
                    <div
                      className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"
                      role="progressbar"
                      aria-label="OS concluídas"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(p.stats.progress * 100)}
                    >
                      <div className="h-full rounded-full bg-brand" style={{ width: `${p.stats.progress * 100}%` }} />
                    </div>
                  </div>
                  <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <dt className="text-ink-muted">Valor</dt>
                      <dd className="font-medium text-ink tabular-nums">{p.contract_value != null ? formatMoney(p.contract_value) : "—"}</dd>
                    </div>
                    <div title="Custos extras lançados nas OS e o valor dos técnicos">
                      <dt className="text-ink-muted">Custos</dt>
                      <dd className="font-medium text-ink tabular-nums">{formatMoney(projectCosts(p.stats))}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-muted">Margem</dt>
                      <dd
                        className={clsx(
                          "font-medium tabular-nums",
                          p.margin != null && p.margin < 0 ? "text-red-600 dark:text-red-400" : "text-ink",
                        )}
                      >
                        {p.margin != null ? formatMoney(p.margin) : "—"}
                      </dd>
                    </div>
                  </dl>
                  {p.end_date ? (
                    <p className={clsx("mt-auto pt-3 text-xs", late ? "font-medium text-red-600 dark:text-red-400" : "text-ink-muted")}>
                      Entrega prevista {formatDate(p.end_date)}
                      {late ? " · atrasada" : ""}
                    </p>
                  ) : null}
                </Card>
              </Link>
            );
          })}
        </div>
      )}
      {creating ? <ProjectDialog project={null} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
