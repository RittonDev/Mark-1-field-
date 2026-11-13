"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Project, ProjectStatus, UUID } from "./types";

/** Situação do projeto. A cor vai na etiqueta (Pill), que escurece o texto para manter o contraste AA. */
export const PROJECT_STATUS: Record<ProjectStatus, { label: string; color: string }> = {
  planning: { label: "Planejamento", color: "#64748b" },
  active: { label: "Em andamento", color: "#2447ff" },
  paused: { label: "Pausado", color: "#d97706" },
  done: { label: "Concluído", color: "#10b981" },
  cancelled: { label: "Cancelado", color: "#ef4444" },
};

/** Projeto em curso: a data de entrega ainda vale. */
const RUNNING: ProjectStatus[] = ["planning", "active", "paused"];

/** A entrega prevista já passou e o projeto não terminou. `today` é "AAAA-MM-DD" no fuso de quem usa. */
export function projectLate(project: Pick<Project, "end_date" | "status">, today: string): boolean {
  return project.end_date !== null && project.end_date < today && RUNNING.includes(project.status);
}

export function useProjects(params: { status?: ProjectStatus; q?: string; customerId?: UUID | null; enabled?: boolean } = {}) {
  const { status, q, customerId, enabled = true } = params;
  return useQuery({
    queryKey: ["projects", status ?? "", q ?? "", customerId ?? ""],
    queryFn: () => api.get<Project[]>("/projects", { status, q: q || undefined, customer_id: customerId ?? undefined }),
    enabled,
    staleTime: 30_000,
    // Trocar a busca ou o filtro mantém os cartões na tela até a resposta chegar.
    placeholderData: (previous) => previous,
  });
}
