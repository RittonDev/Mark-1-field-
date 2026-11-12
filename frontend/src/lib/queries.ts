"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type {
  AssignableUser,
  Category,
  Customer,
  DayActivities,
  Location,
  Page,
  ServiceType,
  Team,
  User,
  UUID,
} from "./types";

const LOOKUP_STALE = 60_000;

export function useTeams() {
  return useQuery({ queryKey: ["teams"], queryFn: () => api.get<Team[]>("/teams"), staleTime: LOOKUP_STALE });
}

export function useCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: () => api.get<Category[]>("/categories"),
    staleTime: LOOKUP_STALE,
  });
}

export function useCustomers(q?: string) {
  return useQuery({
    queryKey: ["customers", q ?? ""],
    queryFn: () => api.get<Customer[]>("/customers", { q }),
    staleTime: LOOKUP_STALE,
  });
}

export function useLocations(customerId: UUID | null | undefined) {
  return useQuery({
    queryKey: ["locations", customerId],
    queryFn: () => api.get<Location[]>(`/customers/${customerId}/locations`),
    enabled: Boolean(customerId),
    staleTime: LOOKUP_STALE,
  });
}

/** Busca de locais (filiais) paginada: nome, código, CNPJ, endereço ou cliente. */
export function useLocationSearch(params: {
  q?: string;
  customerId?: UUID | null;
  active?: boolean;
  page?: number;
  pageSize?: number;
}) {
  const { q, customerId, active, page = 1, pageSize = 50 } = params;
  return useQuery({
    queryKey: ["locations", "search", q ?? "", customerId ?? "", active ?? "", page, pageSize],
    queryFn: () =>
      api.get<Page<Location>>("/locations", {
        q: q || undefined,
        customer_id: customerId ?? undefined,
        active,
        page,
        page_size: pageSize,
      }),
    placeholderData: (prev) => prev,
  });
}

/** Atividades do dia. Chave sob ["tickets"]: o tempo real (WebSocket) já invalida. */
export function useDayActivities(day: string | null, teamId?: UUID | null) {
  return useQuery({
    queryKey: ["tickets", "day", day, teamId ?? ""],
    queryFn: () => api.get<DayActivities>("/activities/day", { date: day ?? undefined, team_id: teamId ?? undefined }),
    enabled: Boolean(day),
    // "Atrasada" depende do relógio: revalida a cada minuto mesmo sem eventos.
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
}

/** Catálogo de tipos de serviço. Com cliente: os gerais + os daquele cliente. */
export function useServiceTypes(params: { customerId?: UUID | null; active?: boolean; enabled?: boolean } = {}) {
  const { customerId, active, enabled = true } = params;
  return useQuery({
    queryKey: ["service-types", customerId ?? "", active ?? ""],
    queryFn: () =>
      api.get<ServiceType[]>("/service-types", { customer_id: customerId ?? undefined, active }),
    staleTime: LOOKUP_STALE,
    enabled,
  });
}

/** Analistas, técnicos e supervisores para atribuição (só a equipe interna pode listar). */
export function useAssignable(teamId?: UUID | null, enabled = true) {
  return useQuery({
    queryKey: ["assignable", teamId ?? ""],
    queryFn: () => api.get<AssignableUser[]>("/users/assignable", { team_id: teamId ?? undefined }),
    staleTime: 15_000,
    enabled,
  });
}

export function useUsers(params: { q?: string; role?: string; team_id?: string } = {}) {
  return useQuery({
    queryKey: ["users", params],
    queryFn: () => api.get<User[]>("/users", params),
  });
}
