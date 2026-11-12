"use client";

import clsx from "clsx";
import { FolderKanban, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ProjectDialog } from "@/components/ProjectDialog";
import { Button, Card, EmptyState, ErrorBox, LoadingBlock, PageHeader, Select } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { formatDate, formatMoney } from "@/lib/format";
import { PROJECT_STATUS, useProjects } from "@/lib/projects";
import type { ProjectStatus } from "@/lib/types";

export default function ProjectsPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<ProjectStatus | "">("active");
  const [creating, setCreating] = useState(false);
  const projects = useProjects({ status: status || undefined });
  if (user && !canManageTickets(user.role)) return <ErrorBox message="Projetos são da gestão." />;

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
      <div className="mb-4 w-full sm:w-56">
        <Select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus | "")} aria-label="Situação">
          <option value="">Todos</option>
          {Object.entries(PROJECT_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
      </div>
      {projects.isLoading ? (
        <LoadingBlock />
      ) : (projects.data ?? []).length === 0 ? (
        <Card>
          <EmptyState
            icon={<FolderKanban className="size-6" />}
            title="Nenhum projeto aqui"
            description="Crie um projeto e marque as OS dele (em Nova OS ou em Editar OS)."
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(projects.data ?? []).map((p) => (
            <Link key={p.id} href={`/projetos/${p.id}`}>
              <Card className="flex h-full flex-col p-4 transition-colors hover:border-brand/50">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-ink-muted">{p.code}</p>
                    <h2 className="truncate font-medium text-ink">{p.name}</h2>
                    <p className="truncate text-sm text-ink-muted">{p.customer?.name ?? "Sem cliente"}</p>
                  </div>
                  <span className={clsx("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", PROJECT_STATUS[p.status].className)}>
                    {PROJECT_STATUS[p.status].label}
                  </span>
                </div>
                <div className="mt-4">
                  <div className="flex justify-between text-xs text-ink-muted">
                    <span>
                      {p.stats.tickets_done}/{p.stats.tickets_total} OS concluídas
                    </span>
                    <span className="tabular-nums">{Math.round(p.stats.progress * 100)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div className="brand-gradient h-full rounded-full" style={{ width: `${p.stats.progress * 100}%` }} />
                  </div>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="text-ink-muted">Valor do projeto</dt>
                    <dd className="font-medium text-ink tabular-nums">{p.contract_value != null ? formatMoney(p.contract_value) : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">Custos extras</dt>
                    <dd className="font-medium text-ink tabular-nums">{formatMoney(p.stats.expenses_total)}</dd>
                  </div>
                </dl>
                {p.end_date ? <p className="mt-auto pt-3 text-xs text-ink-muted">Entrega prevista {formatDate(p.end_date)}</p> : null}
              </Card>
            </Link>
          ))}
        </div>
      )}
      {creating ? <ProjectDialog project={null} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
