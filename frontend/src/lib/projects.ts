"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Project, ProjectStatus } from "./types";

export const PROJECT_STATUS: Record<ProjectStatus, { label: string; className: string }> = {
  planning: { label: "Planejamento", className: "bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300" },
  active: { label: "Em andamento", className: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300" },
  paused: { label: "Pausado", className: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
  done: { label: "Concluído", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" },
  cancelled: { label: "Cancelado", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300" },
};

export function useProjects(params: { status?: ProjectStatus; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["projects", params.status ?? ""],
    queryFn: () => api.get<Project[]>("/projects", { status: params.status }),
    enabled: params.enabled ?? true,
    staleTime: 30_000,
  });
}
